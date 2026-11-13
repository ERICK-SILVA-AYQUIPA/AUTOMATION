/**
 * Abstracción del modelo de lenguaje (ADR 037). El motor del asistente solo
 * conoce estas interfaces; hoy la implementa Gemini (gemini.client.ts) y una
 * prueba puede apuntar a un servidor simulado.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema del objeto de argumentos */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /** Identificador del proveedor, si lo envía (se devuelve con el resultado) */
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelTurn {
  /** Texto visible para el cliente (sin pensamientos internos) */
  text: string;
  calls: ToolCall[];
  finishReason: string | null;
  usage: { input: number; output: number };
}

export interface TranscriptEntry {
  role: 'customer' | 'assistant';
  text: string;
}

/** Una conversación con el modelo: guarda el historial en el formato nativo del proveedor */
export interface ChatSession {
  next(): Promise<ModelTurn>;
  addToolResults(results: { call: ToolCall; result: unknown }[]): void;
}

export interface ChatModel {
  readonly configured: boolean;
  start(input: { system: string; transcript: TranscriptEntry[]; tools: ToolSpec[] }, apiKey?: string): ChatSession;
}

/** Error del proveedor. retryable: conviene reintentar más tarde (cuota, caída, tiempo agotado) */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
