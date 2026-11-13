import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { LlmError, type ChatSession, type ModelTurn, type ToolCall, type ToolSpec, type TranscriptEntry } from './chat-model.js';
import { statusFromHttp, type AiProviderAdapter, type ChatOptions, type CheckOutcome, type Credentials, type FieldSpec, type ModelInfo } from './providers/types.js';

/**
 * Cliente REST de la Gemini API (generateContent, v1beta). Formato tomado de la
 * documentación oficial y de los tipos del SDK oficial @google/genai:
 *   POST {base}/v1beta/models/{model}:generateContent   cabecera x-goog-api-key
 *   contents[]: { role: 'user' | 'model', parts: Part[] }
 *   Part: { text } | { functionCall: { id?, name, args } } | { functionResponse: { id?, name, response } },
 *         con thought / thoughtSignature opcionales
 *   tools[].functionDeclarations[]: { name, description, parametersJsonSchema }
 * Los turnos del modelo se reenvían sin modificar para conservar las firmas de
 * pensamiento (thoughtSignature) que exigen los modelos con razonamiento.
 */

interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}
interface GenerateResponse {
  candidates?: { content?: Content; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

const TIMEOUT_MS = 45_000;

@Injectable()
export class GeminiChatModel implements AiProviderAdapter {
  readonly key = 'gemini';
  readonly name = 'Google Gemini';
  readonly fields: FieldSpec[] = [{ key: 'apiKey', label: 'API Key', secret: true, required: true, pattern: /^[\w-]{20,200}$/, hint: 'Google AI Studio → Get API key' }];

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Hay clave del servidor (GEMINI_API_KEY) */
  get configured() {
    return !!this.env.GEMINI_API_KEY;
  }

  /** Modelo del servidor (GEMINI_MODEL), para las asignaciones sin modelo elegido */
  get defaultModel() {
    return this.env.GEMINI_MODEL;
  }

  private get base() {
    return this.env.GEMINI_BASE_URL.replace(/\/$/, '');
  }

  start(input: { system: string; transcript: TranscriptEntry[]; tools: ToolSpec[] }, opts: ChatOptions): ChatSession {
    const contents: Content[] = [];
    // Gemini exige alternar user/model: se agrupan mensajes seguidos del mismo lado
    for (const t of input.transcript) {
      const role = t.role === 'customer' ? 'user' : 'model';
      const last = contents.at(-1);
      if (last?.role === role) last.parts.push({ text: t.text });
      else contents.push({ role, parts: [{ text: t.text }] });
    }
    if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: '(inicio de la conversación)' }] });
    const body = {
      systemInstruction: { parts: [{ text: input.system }] },
      tools: input.tools.length
        ? [{ functionDeclarations: input.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }]
        : undefined,
      toolConfig: input.tools.length ? { functionCallingConfig: { mode: 'AUTO' } } : undefined,
      generationConfig: { temperature: opts.params.temperature ?? 0.4, maxOutputTokens: opts.params.maxOutputTokens },
    };
    return {
      next: () => this.generate(body, contents, opts.creds.secrets.apiKey ?? '', opts.model),
      addToolResults: (results) => {
        contents.push({
          role: 'user',
          parts: results.map(({ call, result }) => ({
            functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: { result } },
          })),
        });
      },
    };
  }

  /**
   * Comprueba la clave del servidor (o la dada) con una petición real y gratuita
   * (models.get): confirma que la clave es válida y que GEMINI_MODEL existe.
   */
  async checkKey(apiKey?: string): Promise<{ ok: boolean; ms: number; detail: string }> {
    const key = apiKey || this.env.GEMINI_API_KEY;
    const t = Date.now();
    if (!key) return { ok: false, ms: 0, detail: 'Sin clave configurada' };
    try {
      const res = await fetch(`${this.base}/v1beta/models/${encodeURIComponent(this.env.GEMINI_MODEL)}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15_000) });
      const raw = await res.text();
      if (res.ok) return { ok: true, ms: Date.now() - t, detail: `Clave válida; modelo ${this.env.GEMINI_MODEL} disponible` };
      return { ok: false, ms: Date.now() - t, detail: `Gemini ${res.status}: ${errorMessage(raw)}` };
    } catch (e) {
      return { ok: false, ms: Date.now() - t, detail: `Sin conexión con Gemini: ${(e as Error).message}` };
    }
  }

  /** Centro de APIs: la clave es válida si Google devuelve su lista de modelos */
  async check(creds: Credentials): Promise<CheckOutcome> {
    const t = Date.now();
    if (!creds.secrets.apiKey) return { status: 'INCOMPLETE', detail: 'Falta la API Key', ms: 0 };
    try {
      const models = await this.listModels(creds);
      return { status: 'CONNECTED', detail: `Clave válida: ${models.length} modelo(s) de generación disponibles`, ms: Date.now() - t };
    } catch (e) {
      const err = e as LlmError;
      return { status: err.status === 400 && /api key/i.test(err.message) ? 'AUTH_ERROR' : statusFromHttp(err.status), detail: err.message, ms: Date.now() - t };
    }
  }

  /** models.list (paginado); solo los que admiten generateContent */
  async listModels(creds: Credentials): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let pageToken = '';
    for (let page = 0; page < 20; page++) {
      let res: Response;
      try {
        res = await fetch(`${this.base}/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers: { 'x-goog-api-key': creds.secrets.apiKey ?? '' }, signal: AbortSignal.timeout(15_000) });
      } catch (e) {
        throw new LlmError(`Sin conexión con Gemini: ${(e as Error).message}`, true);
      }
      const raw = await res.text();
      if (!res.ok) throw new LlmError(`Gemini ${res.status}: ${errorMessage(raw)}`, res.status === 429 || res.status >= 500, res.status);
      const data = JSON.parse(raw) as { models?: { name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }[]; nextPageToken?: string };
      for (const m of data.models ?? []) {
        if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
        out.push({ id: m.name.replace(/^models\//, ''), displayName: m.displayName, contextWindow: m.inputTokenLimit, maxOutputTokens: m.outputTokenLimit });
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return out;
  }

  private async generate(base: object, contents: Content[], key: string, model: string): Promise<ModelTurn> {
    if (!key) throw new LlmError('Falta la clave de Gemini', false);
    const url = `${this.base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ ...base, contents }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new LlmError(`Gemini no respondió: ${(e as Error).message}`, true);
    }
    const raw = await res.text();
    if (!res.ok) {
      // Nunca se registra la clave; el mensaje de Google no la incluye
      throw new LlmError(`Gemini ${res.status}: ${errorMessage(raw)}`, res.status === 429 || res.status === 408 || res.status >= 500, res.status);
    }
    let data: GenerateResponse;
    try {
      data = JSON.parse(raw) as GenerateResponse;
    } catch {
      throw new LlmError('Gemini devolvió una respuesta no válida', true);
    }
    if (data.promptFeedback?.blockReason) throw new LlmError(`Gemini bloqueó la consulta (${data.promptFeedback.blockReason})`, false);
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    // Turno del modelo tal cual (con firmas de pensamiento) para la siguiente llamada
    if (cand?.content) contents.push({ role: 'model', parts });
    const calls: ToolCall[] = parts
      .filter((p) => p.functionCall?.name)
      .map((p) => ({ id: p.functionCall!.id, name: p.functionCall!.name!, args: p.functionCall!.args ?? {} }));
    const text = parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    const u = data.usageMetadata ?? {};
    return {
      text,
      calls,
      finishReason: cand?.finishReason ?? null,
      usage: { input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
    };
  }
}

function errorMessage(raw: string): string {
  try {
    return (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? raw.slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
}
