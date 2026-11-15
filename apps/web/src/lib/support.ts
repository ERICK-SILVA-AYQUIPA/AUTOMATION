/** Centro de soporte (ADR 054): etiquetas y tipos compartidos por el panel de la empresa y el de la plataforma */
export type SupportKind = 'QUESTION' | 'INCIDENT' | 'REQUEST' | 'BILLING';
export type SupportPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type SupportStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_CLIENT' | 'RESOLVED' | 'CLOSED';
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const KIND: Record<SupportKind, string> = { QUESTION: 'Consulta', INCIDENT: 'Incidencia', REQUEST: 'Solicitud', BILLING: 'Facturación y pagos' };
export const PRIORITY: Record<SupportPriority, { label: string; tone: Tone }> = {
  LOW: { label: 'Baja', tone: 'neutral' },
  NORMAL: { label: 'Normal', tone: 'info' },
  HIGH: { label: 'Alta', tone: 'warning' },
  URGENT: { label: 'Urgente', tone: 'danger' },
};
export const STATUS: Record<SupportStatus, { label: string; staff: string; tone: Tone }> = {
  OPEN: { label: 'Abierto', staff: 'Abierto', tone: 'warning' },
  IN_PROGRESS: { label: 'En atención', staff: 'En atención', tone: 'info' },
  WAITING_CLIENT: { label: 'Esperando tu respuesta', staff: 'Esperando al cliente', tone: 'neutral' },
  RESOLVED: { label: 'Resuelto', staff: 'Resuelto', tone: 'success' },
  CLOSED: { label: 'Cerrado', staff: 'Cerrado', tone: 'neutral' },
};
export const SOURCE: Record<string, string> = { TENANT: 'Panel de la empresa', PLATFORM: 'Registrado por el equipo', MONITOR: 'Monitoreo automático' };

export const ticketNo = (n: number) => `SOP-${String(n).padStart(5, '0')}`;

export interface TicketMessage { id: string; authorKind: 'CLIENT' | 'STAFF' | 'SYSTEM'; body: string; internal?: boolean; createdAt: string; author: { name: string } | null }
export interface Ticket {
  id: string; number: number; tenantId: string; kind: SupportKind; priority: SupportPriority; status: SupportStatus; source: 'TENANT' | 'PLATFORM' | 'MONITOR'; subject: string;
  assigneeId: string | null; provisioningRunId: string | null; firstResponseAt: string | null; resolvedAt: string | null; closedAt: string | null;
  rating: number | null; ratingComment: string | null; ratedAt: string | null; lastActivityAt: string; createdAt: string;
  due: { due: string; overdue: boolean };
}
export interface TicketDetail extends Ticket { messages: TicketMessage[] }
