import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../config/env.js';
import { LlmError, type ChatSession, type ModelTurn, type ToolCall, type ToolSpec, type TranscriptEntry } from '../chat-model.js';
import { statusFromHttp, type AiProviderAdapter, type ChatOptions, type CheckOutcome, type Credentials, type FieldSpec, type ModelInfo } from './types.js';

/**
 * Claude (Anthropic) con el SDK oficial `@anthropic-ai/sdk`: Messages API con
 * herramientas propias y bucle manual (lo dirige AssistantService), Models API
 * para validar la clave y listar modelos.
 *
 * Los turnos del modelo se reenvían completos (bloques de pensamiento incluidos),
 * como exige la API. En los modelos que admiten el respaldo del servidor ante un
 * rechazo de seguridad se activa `fallbacks: "default"`: lo resuelve Anthropic
 * con otro modelo de Claude, sin salir del proveedor.
 */

/** Modelos que admiten `fallbacks: "default"` (beta server-side-fallback-2026-07-01) */
const REFUSAL_FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

@Injectable()
export class AnthropicAdapter implements AiProviderAdapter {
  readonly key = 'anthropic';
  readonly name = 'Anthropic Claude';
  readonly fields: FieldSpec[] = [{ key: 'apiKey', label: 'API Key', secret: true, required: true, pattern: /^[\w-]{20,300}$/, hint: 'Claude Console → API keys (empieza por sk-ant-)' }];

  constructor(@Inject(ENV) private readonly env: Env) {}

  private client(creds: Credentials) {
    // Clave explícita: el SDK no debe tomar credenciales del entorno del servidor
    return new Anthropic({ apiKey: creds.secrets.apiKey ?? '', baseURL: this.env.ANTHROPIC_BASE_URL, maxRetries: 1, timeout: 60_000 });
  }

  async check(creds: Credentials): Promise<CheckOutcome> {
    const t = Date.now();
    if (!creds.secrets.apiKey) return { status: 'INCOMPLETE', detail: 'Falta la API Key', ms: 0 };
    try {
      const models = await this.listModels(creds);
      return { status: 'CONNECTED', detail: `Clave válida: ${models.length} modelo(s) disponibles`, ms: Date.now() - t };
    } catch (e) {
      const err = toLlmError(e);
      return { status: statusFromHttp(err.status), detail: err.message, ms: Date.now() - t };
    }
  }

  async listModels(creds: Credentials): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    try {
      for await (const m of this.client(creds).models.list({ limit: 100 })) {
        out.push({ id: m.id, displayName: m.display_name, contextWindow: m.max_input_tokens ?? undefined, maxOutputTokens: m.max_tokens ?? undefined });
        if (out.length >= 500) break;
      }
    } catch (e) {
      throw toLlmError(e);
    }
    return out;
  }

  start(input: { system: string; transcript: TranscriptEntry[]; tools: ToolSpec[] }, opts: ChatOptions): ChatSession {
    const client = this.client(opts.creds);
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const t of input.transcript) {
      const role = t.role === 'customer' ? 'user' : 'assistant';
      const last = messages.at(-1);
      if (last?.role === role && typeof last.content === 'string') last.content = `${last.content}\n${t.text}`;
      else messages.push({ role, content: t.text });
    }
    if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: '(inicio de la conversación)' });
    // Sin prellenado: la conversación debe terminar en un turno del cliente
    if (messages.at(-1)?.role === 'assistant') messages.push({ role: 'user', content: '(continúa la conversación)' });
    const tools: Anthropic.Beta.BetaTool[] = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema }));
    const fallback = REFUSAL_FALLBACK_MODELS.has(opts.model);

    return {
      next: async (): Promise<ModelTurn> => {
        let res: Anthropic.Beta.BetaMessage;
        try {
          res = await client.beta.messages.create({
            model: opts.model,
            max_tokens: opts.params.maxOutputTokens,
            system: input.system,
            messages,
            ...(tools.length ? { tools } : {}),
            ...(opts.params.effort ? { output_config: { effort: opts.params.effort } } : {}),
            ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          });
        } catch (e) {
          throw toLlmError(e);
        }
        // Turno completo tal cual (pensamiento incluido) para la siguiente llamada
        messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
        if (res.stop_reason === 'refusal') return { text: '', calls: [], finishReason: 'refusal', usage: usageOf(res) };
        const calls: ToolCall[] = res.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }));
        const text = res.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        return { text, calls, finishReason: res.stop_reason, usage: usageOf(res) };
      },
      addToolResults: (results) => {
        // Todas las respuestas de herramientas en un único mensaje del usuario
        messages.push({
          role: 'user',
          content: results.map(({ call, result }) => ({ type: 'tool_result' as const, tool_use_id: call.id ?? '', content: JSON.stringify(result) })),
        });
      },
    };
  }
}

function usageOf(res: Anthropic.Beta.BetaMessage) {
  const u = res.usage;
  return { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 };
}

/** Errores tipados del SDK → LlmError (nunca incluyen la clave) */
function toLlmError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof Anthropic.APIConnectionError) return new LlmError(`Sin conexión con Anthropic: ${e.message}`, true);
  if (e instanceof Anthropic.APIError) {
    const status = e.status;
    const msg = (e.error as { error?: { message?: string } } | undefined)?.error?.message ?? e.message;
    return new LlmError(`Anthropic ${status ?? ''}: ${msg}`.slice(0, 400), status === 429 || status === 408 || status === 529 || (status ?? 0) >= 500, status);
  }
  return new LlmError(`Anthropic: ${(e as Error).message}`, false);
}
