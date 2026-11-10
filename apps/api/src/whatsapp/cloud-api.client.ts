import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

/**
 * Cliente mínimo de WhatsApp Cloud API (Graph). Solo usa operaciones verificadas
 * en la documentación oficial (docs/integrations/whatsapp-cloud-api.md).
 */

/** Destinatario: teléfono (E.164 sin "+") o BSUID ("CC.xxxx") */
export type Recipient = { phone: string } | { bsuid: string };

export class WhatsappApiError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Códigos que conviene reintentar más tarde (límites y fallos temporales) */
const RETRYABLE = new Set([130429, 131056, 131000, 131016, 4, 80007]);

export function classify(code: number | null, httpStatus: number): boolean {
  if (code !== null && RETRYABLE.has(code)) return true;
  if (code === null) return httpStatus >= 500 || httpStatus === 429 || httpStatus === 0;
  return false;
}

export interface PhoneNumberInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
}

@Injectable()
export class CloudApiClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  private url(path: string) {
    return `${this.env.WHATSAPP_GRAPH_BASE_URL.replace(/\/$/, '')}/${this.env.WHATSAPP_GRAPH_API_VERSION}/${path}`;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) };
      if (method === 'POST') {
        init.headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body ?? {});
      }
      res = await fetch(this.url(path), init);
    } catch (e) {
      throw new WhatsappApiError(null, `Sin conexión con WhatsApp: ${(e as Error).message}`, 0, true);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string; error_data?: { details?: string } } } & T;
    if (!res.ok || json.error) {
      const code = typeof json.error?.code === 'number' ? json.error.code : null;
      const msg = json.error?.error_data?.details ?? json.error?.message ?? `HTTP ${res.status}`;
      throw new WhatsappApiError(code, msg, res.status, classify(code, res.status));
    }
    return json;
  }

  /** Datos del número (sirve para probar token + phone_number_id) */
  phoneNumberInfo(phoneNumberId: string, token: string) {
    return this.call<PhoneNumberInfo>('GET', encodeURIComponent(phoneNumberId), token);
  }

  private target(r: Recipient) {
    return 'phone' in r ? { to: r.phone } : { recipient: r.bsuid };
  }

  async sendText(phoneNumberId: string, token: string, to: Recipient, text: string): Promise<string> {
    const r = await this.call<{ messages?: { id: string }[] }>('POST', `${encodeURIComponent(phoneNumberId)}/messages`, token, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...this.target(to),
      type: 'text',
      text: { preview_url: false, body: text.slice(0, 4096) },
    });
    const id = r.messages?.[0]?.id;
    if (!id) throw new WhatsappApiError(null, 'WhatsApp no devolvió el id del mensaje', 200, false);
    return id;
  }

  /** Plantilla aprobada, sin variables (las plantillas con variables se añaden con la FASE 7) */
  async sendTemplate(phoneNumberId: string, token: string, to: Recipient, name: string, languageCode: string): Promise<string> {
    const r = await this.call<{ messages?: { id: string }[] }>('POST', `${encodeURIComponent(phoneNumberId)}/messages`, token, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...this.target(to),
      type: 'template',
      template: { name, language: { code: languageCode } },
    });
    const id = r.messages?.[0]?.id;
    if (!id) throw new WhatsappApiError(null, 'WhatsApp no devolvió el id del mensaje', 200, false);
    return id;
  }
}
