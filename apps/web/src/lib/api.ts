/**
 * Cliente HTTP de la API. El access token vive solo en memoria (no en
 * localStorage) y se renueva con la cookie HttpOnly de refresh + cabecera CSRF.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
let onSessionExpired: (() => void) | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const setSessionExpiredHandler = (fn: () => void) => {
  onSessionExpired = fn;
};

const readCookie = (name: string) =>
  typeof document === 'undefined' ? undefined : document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.split('=')[1];

export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) {
    refreshing = (async () => {
      const csrf = readCookie('aisa_csrf');
      if (!csrf) return null;
      const r = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf } });
      if (!r.ok) return null;
      const body = (await r.json()) as { accessToken: string };
      accessToken = body.accessToken;
      return accessToken;
    })().finally(() => {
      setTimeout(() => (refreshing = null), 0);
    });
  }
  return refreshing;
}

type Opts = Omit<RequestInit, 'body'> & { body?: unknown; query?: Record<string, string | number | boolean | undefined | null> };

export async function api<T = unknown>(path: string, opts: Opts = {}, retry = true): Promise<T> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const isForm = opts.body instanceof FormData;
  const headers = new Headers(opts.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (opts.body !== undefined && !isForm) headers.set('Content-Type', 'application/json');
  const csrf = readCookie('aisa_csrf');
  if (csrf) headers.set('X-CSRF-Token', csrf);

  const res = await fetch(url, {
    ...opts,
    headers,
    credentials: 'include',
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
  });

  if (res.status === 401 && retry && !path.startsWith('/auth/login')) {
    const t = await refreshAccessToken();
    if (t) return api<T>(path, opts, false);
    accessToken = null;
    onSessionExpired?.();
  }
  if (!res.ok) {
    let body: { message?: string | string[]; code?: string; errors?: { path: string; message: string }[] } = {};
    try {
      body = await res.json();
    } catch {
      /* respuesta sin JSON */
    }
    const msg = Array.isArray(body.message) ? body.message.join('. ') : body.message;
    throw new ApiError(res.status, msg ?? (res.status === 429 ? 'Demasiadas solicitudes. Espera un momento.' : 'Ocurrió un error inesperado'), body.code, body.errors);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? res.json() : res.blob()) as Promise<T>;
}

/** Descarga un archivo autenticado (CSV/XLSX) usando el nombre que indica el servidor */
export async function download(path: string, query?: Opts['query'], retry = true): Promise<void> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: 'include' });
  if (res.status === 401 && retry && (await refreshAccessToken())) return download(path, query, false);
  if (!res.ok) throw new ApiError(res.status, 'No se pudo descargar el archivo');
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'descarga';
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
