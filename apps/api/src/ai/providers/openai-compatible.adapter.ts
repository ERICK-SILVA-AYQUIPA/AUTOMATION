import { Inject, Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { ENV, type Env } from '../../config/env.js';
import { LlmError, type ChatSession, type ModelTurn, type ToolCall, type ToolSpec, type TranscriptEntry } from '../chat-model.js';
import { statusFromHttp, type AiProviderAdapter, type ChatOptions, type CheckOutcome, type Credentials, type FieldSpec, type ModelInfo } from './types.js';

/**
 * Chat Completions con el SDK oficial `openai`. Lo usan OpenAI y DeepSeek, cuya
 * API sigue el formato de OpenAI (https://api.deepseek.com, `GET /models`,
 * `POST /chat/completions` con `tools` y mensajes `role: tool`).
 */
abstract class OpenAiCompatibleAdapter implements AiProviderAdapter {
  abstract readonly key: string;
  abstract readonly name: string;
  abstract readonly fields: FieldSpec[];
  protected abstract readonly baseURL: string;
  /** OpenAI: max_completion_tokens; DeepSeek: max_tokens */
  protected abstract readonly tokenParam: 'max_completion_tokens' | 'max_tokens';
  protected abstract effortValue(e: 'low' | 'medium' | 'high'): string;

  protected client(creds: Credentials) {
    // Todo explícito: el SDK no debe tomar organización, proyecto ni clave del entorno del servidor
    return new OpenAI({
      apiKey: creds.secrets.apiKey ?? '',
      baseURL: this.baseURL,
      organization: creds.config.organization ?? null,
      project: creds.config.project ?? null,
      maxRetries: 1,
      timeout: 60_000,
    });
  }

  async check(creds: Credentials): Promise<CheckOutcome> {
    const t = Date.now();
    if (!creds.secrets.apiKey) return { status: 'INCOMPLETE', detail: 'Falta la API Key', ms: 0 };
    try {
      const models = await this.listModels(creds);
      return { status: 'CONNECTED', detail: `Clave válida: ${models.length} modelo(s) disponibles`, ms: Date.now() - t };
    } catch (e) {
      const err = this.toLlmError(e);
      return { status: statusFromHttp(err.status), detail: err.message, ms: Date.now() - t };
    }
  }

  async listModels(creds: Credentials): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    try {
      for await (const m of this.client(creds).models.list()) {
        // DeepSeek añade nombre y límites; OpenAI solo id
        const x = m as unknown as { id: string; name?: string; context_window?: number; max_output_tokens?: number };
        out.push({ id: x.id, displayName: x.name, contextWindow: x.context_window, maxOutputTokens: x.max_output_tokens });
        if (out.length >= 500) break;
      }
    } catch (e) {
      throw this.toLlmError(e);
    }
    return out;
  }

  start(input: { system: string; transcript: TranscriptEntry[]; tools: ToolSpec[] }, opts: ChatOptions): ChatSession {
    const client = this.client(opts.creds);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: input.system }];
    for (const t of input.transcript) messages.push(t.role === 'customer' ? { role: 'user', content: t.text } : { role: 'assistant', content: t.text });
    const tools: OpenAI.Chat.ChatCompletionTool[] = input.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

    return {
      next: async (): Promise<ModelTurn> => {
        let res: OpenAI.Chat.ChatCompletion;
        try {
          res = await client.chat.completions.create({
            model: opts.model,
            messages,
            ...(tools.length ? { tools } : {}),
            [this.tokenParam]: opts.params.maxOutputTokens,
            ...(opts.params.temperature !== undefined ? { temperature: opts.params.temperature } : {}),
            ...(opts.params.effort ? { reasoning_effort: this.effortValue(opts.params.effort) } : {}),
          } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
        } catch (e) {
          throw this.toLlmError(e);
        }
        const choice = res.choices[0];
        const msg = choice?.message;
        // Se reenvía el mensaje del modelo completo (DeepSeek puede incluir reasoning_content)
        if (msg) messages.push(msg as OpenAI.Chat.ChatCompletionAssistantMessageParam);
        const calls: ToolCall[] = [];
        for (const c of msg?.tool_calls ?? []) {
          if (c.type !== 'function') continue;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            args = {};
          }
          calls.push({ id: c.id, name: c.function.name, args });
        }
        return {
          text: (msg?.content ?? '').trim(),
          calls,
          finishReason: choice?.finish_reason ?? null,
          usage: { input: res.usage?.prompt_tokens ?? 0, output: res.usage?.completion_tokens ?? 0 },
        };
      },
      addToolResults: (results) => {
        for (const { call, result } of results) messages.push({ role: 'tool', tool_call_id: call.id ?? '', content: JSON.stringify(result) });
      },
    };
  }

  protected toLlmError(e: unknown): LlmError {
    if (e instanceof LlmError) return e;
    if (e instanceof OpenAI.APIConnectionError) return new LlmError(`Sin conexión con ${this.name}: ${e.message}`, true);
    if (e instanceof OpenAI.APIError) {
      const status = e.status;
      const msg = (e.error as { message?: string } | undefined)?.message ?? e.message;
      return new LlmError(`${this.name} ${status ?? ''}: ${msg}`.slice(0, 400), status === 429 || status === 408 || (status ?? 0) >= 500, status);
    }
    return new LlmError(`${this.name}: ${(e as Error).message}`, false);
  }
}

@Injectable()
export class OpenAiAdapter extends OpenAiCompatibleAdapter {
  readonly key = 'openai';
  readonly name = 'OpenAI';
  readonly fields: FieldSpec[] = [
    { key: 'apiKey', label: 'API Key', secret: true, required: true, pattern: /^[\w-]{20,300}$/, hint: 'platform.openai.com → API keys' },
    { key: 'organization', label: 'Organization ID', secret: false, required: false, pattern: /^org-[\w-]{4,60}$/, hint: 'Opcional' },
    { key: 'project', label: 'Project ID', secret: false, required: false, pattern: /^proj_[\w-]{4,60}$/, hint: 'Opcional' },
  ];
  protected readonly tokenParam = 'max_completion_tokens' as const;
  constructor(@Inject(ENV) private readonly env: Env) {
    super();
  }
  protected get baseURL() {
    return this.env.OPENAI_BASE_URL;
  }
  protected effortValue(e: 'low' | 'medium' | 'high') {
    return e;
  }
}

@Injectable()
export class DeepSeekAdapter extends OpenAiCompatibleAdapter {
  readonly key = 'deepseek';
  readonly name = 'DeepSeek';
  readonly fields: FieldSpec[] = [{ key: 'apiKey', label: 'API Key', secret: true, required: true, pattern: /^[\w-]{20,300}$/, hint: 'platform.deepseek.com → API keys' }];
  protected readonly tokenParam = 'max_tokens' as const;
  constructor(@Inject(ENV) private readonly env: Env) {
    super();
  }
  protected get baseURL() {
    return this.env.DEEPSEEK_BASE_URL;
  }
  /** DeepSeek admite none, low, high y max (sin «medium») */
  protected effortValue(e: 'low' | 'medium' | 'high') {
    return e === 'medium' ? 'high' : e;
  }
}
