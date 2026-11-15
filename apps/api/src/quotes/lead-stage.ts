import { createHash, randomBytes } from 'node:crypto';
import type { Tx } from '../database/database.service.js';
import type { SalesLeadStatus } from '../generated/prisma/client.js';
import { logSalesActivity } from '../sales/sales.service.js';

/** Etapa siguiente del prospecto por un hecho comercial (cotización enviada o aceptada, pago validado) */
export async function advanceLead(tx: Tx, leadId: string, to: SalesLeadStatus, from: SalesLeadStatus[], by: string, userId: string | null) {
  const lead = await tx.salesLead.findUniqueOrThrow({ where: { id: leadId }, select: { status: true } });
  if (!from.includes(lead.status)) return false;
  const r = await tx.salesLead.updateMany({ where: { id: leadId, status: lead.status }, data: { status: to, statusChangedAt: new Date() } });
  if (r.count === 1) await logSalesActivity(tx, leadId, userId, 'STATUS_CHANGED', null, { from: lead.status, to, by });
  return r.count === 1;
}

export const EARLY_TO_QUOTE: SalesLeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'DEMO_REQUESTED'];
export const BEFORE_PAYMENT: SalesLeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'DEMO_REQUESTED', 'QUOTE_SENT', 'NEGOTIATION'];

/** Enlace de acceso para el cliente: el token va solo en el enlace; se guarda su SHA-256 */
export function newAccessToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Fecha de hoy en Lima (las vigencias son fechas, no instantes) */
export function todayLima() {
  return dateLima(new Date());
}
export function dateLima(d: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
