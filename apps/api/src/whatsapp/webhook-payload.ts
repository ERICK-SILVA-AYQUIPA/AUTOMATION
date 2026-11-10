import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Lectura del webhook de WhatsApp Cloud API. El contenido es NO CONFIABLE:
 * se valida la forma, se recortan longitudes y se ignora lo desconocido.
 */

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(cuerpo crudo, App Secret) */
export function validSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=') || !appSecret) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.slice(7), 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const str = (max: number) => z.string().max(max);
const message = z.object({
  id: str(256),
  from: str(32).optional(),
  from_user_id: str(160).optional(),
  timestamp: str(20).optional(),
  type: str(40),
  text: z.object({ body: str(8192) }).optional(),
  button: z.object({ text: str(1024).optional() }).optional(),
  interactive: z
    .object({
      type: str(40).optional(),
      button_reply: z.object({ id: str(256).optional(), title: str(256).optional() }).optional(),
      list_reply: z.object({ id: str(256).optional(), title: str(256).optional() }).optional(),
    })
    .optional(),
});
const status = z.object({
  id: str(256),
  status: str(20),
  timestamp: str(20).optional(),
  recipient_id: str(64).optional(),
  recipient_user_id: str(160).optional(),
  errors: z.array(z.object({ code: z.number().optional(), title: str(512).optional(), message: str(1024).optional(), error_data: z.object({ details: str(2048).optional() }).optional() })).optional(),
});
const contact = z.object({ wa_id: str(32).optional(), user_id: str(160).optional(), profile: z.object({ name: str(256).optional() }).optional() });
const payload = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({
              metadata: z.object({ phone_number_id: str(64), display_phone_number: str(32).optional() }).optional(),
              contacts: z.array(contact).max(100).optional(),
              messages: z.array(z.unknown()).max(1000).optional(),
              statuses: z.array(z.unknown()).max(1000).optional(),
            })
            .passthrough(),
        }),
      ),
    }),
  ),
});

export interface InboundMessageEvent {
  kind: 'message';
  phoneNumberId: string;
  wamid: string;
  phone: string | null;
  bsuid: string | null;
  profileName: string | null;
  timestamp: number | null;
  type: string;
  /** Texto del mensaje, o null si el tipo aún no se procesa (imagen, audio…) */
  text: string | null;
}
export interface StatusEvent {
  kind: 'status';
  phoneNumberId: string;
  wamid: string;
  status: 'sent' | 'delivered' | 'read' | 'played' | 'failed';
  timestamp: number | null;
  error: { code: number | null; message: string } | null;
}
export type WhatsappEvent = InboundMessageEvent | StatusEvent;

const STATUSES = new Set(['sent', 'delivered', 'read', 'played', 'failed']);
const ts = (v?: string) => (v && /^\d{1,12}$/.test(v) ? Number(v) : null);
const digits = (v?: string | null) => (v ? v.replace(/\D/g, '') || null : null);

/** Convierte el cuerpo en eventos. Lanza si la forma general no es la esperada. */
export function parseWebhook(body: unknown): WhatsappEvent[] {
  const p = payload.parse(body);
  const out: WhatsappEvent[] = [];
  for (const e of p.entry) {
    for (const ch of e.changes) {
      if (ch.field !== 'messages' || !ch.value.metadata) continue;
      const phoneNumberId = ch.value.metadata.phone_number_id;
      const contacts = ch.value.contacts ?? [];
      for (const raw of ch.value.messages ?? []) {
        const m = message.safeParse(raw);
        if (!m.success) continue;
        const d = m.data;
        const c = contacts.find((x) => (d.from && x.wa_id === d.from) || (d.from_user_id && x.user_id === d.from_user_id)) ?? (contacts.length === 1 ? contacts[0] : undefined);
        const phone = digits(d.from ?? c?.wa_id);
        const bsuid = d.from_user_id ?? c?.user_id ?? null;
        if (!phone && !bsuid) continue;
        const text =
          d.type === 'text' ? (d.text?.body ?? null)
          : d.type === 'button' ? (d.button?.text ?? null)
          : d.type === 'interactive' ? (d.interactive?.button_reply?.title ?? d.interactive?.list_reply?.title ?? null)
          : null;
        out.push({ kind: 'message', phoneNumberId, wamid: d.id, phone, bsuid, profileName: c?.profile?.name?.trim() || null, timestamp: ts(d.timestamp), type: d.type, text });
      }
      for (const raw of ch.value.statuses ?? []) {
        const s = status.safeParse(raw);
        if (!s.success || !STATUSES.has(s.data.status)) continue;
        const err = s.data.errors?.[0];
        out.push({
          kind: 'status', phoneNumberId, wamid: s.data.id, status: s.data.status as StatusEvent['status'], timestamp: ts(s.data.timestamp),
          error: err ? { code: err.code ?? null, message: err.error_data?.details ?? err.message ?? err.title ?? 'Error' } : null,
        });
      }
    }
  }
  return out;
}
