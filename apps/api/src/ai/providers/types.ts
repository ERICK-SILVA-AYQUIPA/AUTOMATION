import type { ChatSession, ToolSpec, TranscriptEntry } from '../chat-model.js';

/**
 * Contrato común de los proveedores de IA del Centro de APIs (ADR 046).
 * Cada adaptador traduce al formato nativo de su API; el resto del sistema
 * solo conoce este contrato.
 */

/** Estados que muestra el panel. Solo una respuesta real del proveedor da CONNECTED */
export type CredentialStatus =
  | 'CONNECTED'
  | 'CONNECTED_WITH_WARNINGS'
  | 'AUTH_ERROR'
  | 'PERMISSION_DENIED'
  | 'UNAVAILABLE'
  | 'INCOMPLETE'
  | 'PENDING_AUTHORIZATION'
  | 'DISABLED';

export interface FieldSpec {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  /** Patrón que debe cumplir (se valida antes de llamar al proveedor) */
  pattern?: RegExp;
  hint?: string;
}

export interface CheckOutcome {
  status: CredentialStatus;
  detail: string;
  ms: number;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** Parámetros de generación admitidos (los que no aplican a un proveedor se ignoran) */
export interface GenerationParams {
  maxOutputTokens: number;
  temperature?: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface Credentials {
  /** Campos secretos (apiKey, …) */
  secrets: Record<string, string>;
  /** Campos no secretos (organización, proyecto, …) */
  config: Record<string, string>;
}

export interface ChatOptions {
  creds: Credentials;
  model: string;
  params: GenerationParams;
}

export interface AiProviderAdapter {
  readonly key: string;
  readonly name: string;
  readonly fields: FieldSpec[];
  /** Petición real y sin costo de generación (listar modelos) */
  check(creds: Credentials): Promise<CheckOutcome>;
  listModels(creds: Credentials): Promise<ModelInfo[]>;
  start(input: { system: string; transcript: TranscriptEntry[]; tools: ToolSpec[] }, opts: ChatOptions): ChatSession;
}

/** Traduce el código HTTP del proveedor al estado del panel */
export function statusFromHttp(status: number | undefined): CredentialStatus {
  if (status === 401) return 'AUTH_ERROR';
  if (status === 403) return 'PERMISSION_DENIED';
  // Clave aceptada pero sin cuota o limitada por ahora
  if (status === 429) return 'CONNECTED_WITH_WARNINGS';
  return 'UNAVAILABLE';
}

export const STATUS_LABEL: Record<CredentialStatus, string> = {
  CONNECTED: 'Conectado',
  CONNECTED_WITH_WARNINGS: 'Conectado con advertencias',
  AUTH_ERROR: 'Error de autenticación',
  PERMISSION_DENIED: 'Sin permisos',
  UNAVAILABLE: 'Servicio no disponible',
  INCOMPLETE: 'Configuración incompleta',
  PENDING_AUTHORIZATION: 'Pendiente de autorización',
  DISABLED: 'Desconectado',
};

/** Valida los campos contra la ficha del proveedor. Devuelve el primer error o null */
export function validateFields(fields: FieldSpec[], values: Record<string, unknown>): { secrets: Record<string, string>; config: Record<string, string> } | string {
  const secrets: Record<string, string> = {};
  const config: Record<string, string> = {};
  const allowed = new Set(fields.map((f) => f.key));
  for (const k of Object.keys(values)) if (!allowed.has(k)) return `Campo no admitido: ${k}`;
  for (const f of fields) {
    const raw = values[f.key];
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) {
      if (f.required) return `Falta ${f.label}`;
      continue;
    }
    if (v.length > 500 || (f.pattern && !f.pattern.test(v))) return `${f.label} no tiene un formato válido`;
    (f.secret ? secrets : config)[f.key] = v;
  }
  return { secrets, config };
}

/** Últimos 4 caracteres del primer secreto (nunca la clave completa) */
export function hintOf(secrets: Record<string, string>): string {
  const first = Object.values(secrets)[0] ?? '';
  return first.length > 8 ? `…${first.slice(-4)}` : '…';
}
