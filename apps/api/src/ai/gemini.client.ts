import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { LlmError, type ChatModel, type ChatSession, type ModelTurn, type ToolCall, type ToolSpec, type TranscriptEntry } from './chat-model.js';

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
export class GeminiChatModel implements ChatModel {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get configured() {
    return !!this.env.GEMINI_API_KEY;
  }

  /** `apiKey`: clave propia de la empresa; sin ella, la de la plataforma */
  start(input: { system: string; transcript: TranscriptEntry[]; tools: ToolSpec[] }, apiKey?: string): ChatSession {
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
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    };
    return {
      next: () => this.generate(body, contents, apiKey || this.env.GEMINI_API_KEY),
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
   * Comprueba la clave con una petición real y gratuita (models.get): confirma
   * que la clave es válida y que el modelo configurado existe para ella.
   */
  async check(apiKey?: string): Promise<{ ok: boolean; ms: number; detail: string }> {
    const key = apiKey || this.env.GEMINI_API_KEY;
    const t = Date.now();
    if (!key) return { ok: false, ms: 0, detail: 'Sin clave configurada' };
    const url = `${this.env.GEMINI_BASE_URL.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(this.env.GEMINI_MODEL)}`;
    try {
      const res = await fetch(url, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15_000) });
      const raw = await res.text();
      if (res.ok) return { ok: true, ms: Date.now() - t, detail: `Clave válida; modelo ${this.env.GEMINI_MODEL} disponible` };
      let msg = raw.slice(0, 200);
      try {
        msg = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        /* cuerpo no JSON */
      }
      return { ok: false, ms: Date.now() - t, detail: `Gemini ${res.status}: ${msg}` };
    } catch (e) {
      return { ok: false, ms: Date.now() - t, detail: `Sin conexión con Gemini: ${(e as Error).message}` };
    }
  }

  private async generate(base: object, contents: Content[], key: string): Promise<ModelTurn> {
    if (!key) throw new LlmError('Falta GEMINI_API_KEY', false);
    const url = `${this.env.GEMINI_BASE_URL.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(this.env.GEMINI_MODEL)}:generateContent`;
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
      let msg = raw.slice(0, 300);
      try {
        msg = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        /* cuerpo no JSON */
      }
      throw new LlmError(`Gemini ${res.status}: ${msg}`, res.status === 429 || res.status === 408 || res.status >= 500, res.status);
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
