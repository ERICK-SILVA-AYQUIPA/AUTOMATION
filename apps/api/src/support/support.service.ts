import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { SupportPriority, SupportStatus } from '../generated/prisma/enums.js';
import { MailService } from '../mail/mail.service.js';

export const ticketNo = (n: number) => `SOP-${String(n).padStart(5, '0')}`;

const KINDS = ['QUESTION', 'INCIDENT', 'REQUEST', 'BILLING'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_CLIENT', 'RESOLVED', 'CLOSED'] as const;
const body = z.string().trim().min(1, 'Escribe el mensaje').max(10_000);

export const KIND_LABEL: Record<(typeof KINDS)[number], string> = { QUESTION: 'Consulta', INCIDENT: 'Incidencia', REQUEST: 'Solicitud', BILLING: 'Facturación y pagos' };
export const STATUS_LABEL: Record<SupportStatus, string> = { OPEN: 'Abierto', IN_PROGRESS: 'En atención', WAITING_CLIENT: 'Esperando tu respuesta', RESOLVED: 'Resuelto', CLOSED: 'Cerrado' };
/** Plazo de la primera respuesta del equipo según la prioridad (horas) */
export const FIRST_RESPONSE_HOURS: Record<SupportPriority, number> = { URGENT: 2, HIGH: 8, NORMAL: 24, LOW: 72 };

export const createTicketSchema = z.object({
  kind: z.enum(KINDS),
  priority: z.enum(PRIORITIES).default('NORMAL'),
  subject: z.string().trim().min(3, 'Escribe el asunto').max(200),
  body,
});
export const staffTicketSchema = createTicketSchema.extend({ tenantId: z.uuid() });
export const messageSchema = z.object({ body });
export const staffMessageSchema = z.object({ body, internal: z.boolean().default(false) });
export const updateTicketSchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.uuid().nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, 'Nada que cambiar');
export const rateSchema = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(2000).optional() });
export const listSchema = z.object({ status: z.enum([...STATUSES, 'active']).optional(), tenantId: z.uuid().optional(), q: z.string().trim().max(100).optional() });

const CLOSED: SupportStatus[] = ['RESOLVED', 'CLOSED'];
const TICKET = {
  id: true, number: true, tenantId: true, kind: true, priority: true, status: true, source: true, subject: true, createdById: true, assigneeId: true, provisioningRunId: true,
  firstResponseAt: true, resolvedAt: true, closedAt: true, rating: true, ratingComment: true, ratedAt: true, lastActivityAt: true, createdAt: true,
} as const;

/** Vence la primera respuesta si nadie del equipo respondió dentro del plazo de su prioridad */
export function responseDue(t: { priority: SupportPriority; createdAt: Date; firstResponseAt: Date | null; status: SupportStatus }) {
  const due = new Date(t.createdAt.getTime() + FIRST_RESPONSE_HOURS[t.priority] * 3_600_000);
  return { due, overdue: !t.firstResponseAt && !CLOSED.includes(t.status) && due < new Date() };
}

/**
 * Centro de soporte (ADR 054). La empresa abre y sigue sus casos con el rol de
 * ejecución (RLS: solo los suyos y nunca las notas internas); el equipo de la
 * plataforma los atiende con el rol de sistema. Cada cambio queda en auditoría.
 */
@Injectable()
export class SupportService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  // ---------------------------------------------------------------- Empresa

  /** En una instalación independiente los casos no llegan a la plataforma: se muestra el contacto */
  async info(tenantId: string) {
    const t = await this.db.tenant(tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { deploymentMode: true } }));
    return { tickets: t.deploymentMode === 'SAAS', contact: this.env.SUPPORT_CONTACT || null, firstResponseHours: FIRST_RESPONSE_HOURS };
  }

  private async requireTickets(tenantId: string) {
    if (!(await this.info(tenantId)).tickets) throw new ConflictException({ code: 'SUPPORT_EXTERNAL', message: 'Esta instalación es independiente: escribe al contacto de soporte que figura en esta página' });
  }

  listOwn(tenantId: string) {
    return this.db.tenant(tenantId, (tx) => tx.supportTicket.findMany({ orderBy: { lastActivityAt: 'desc' }, take: 200, select: TICKET }));
  }

  async create(tenantId: string, userId: string, input: z.infer<typeof createTicketSchema>) {
    await this.requireTickets(tenantId);
    const t = await this.db.tenant(tenantId, async (tx) => {
      const ticket = await tx.supportTicket.create({ data: { tenantId, kind: input.kind, priority: input.priority, subject: input.subject, source: 'TENANT', createdById: userId }, select: TICKET });
      await tx.supportMessage.create({ data: { ticketId: ticket.id, tenantId, authorKind: 'CLIENT', authorId: userId, body: input.body } });
      return ticket;
    });
    await this.audit.system({ tenantId, userId, action: 'support.created', entityType: 'support_ticket', entityId: t.id, metadata: { number: t.number, kind: t.kind, priority: t.priority } });
    await this.notifyStaff(t.id, `Nuevo caso ${ticketNo(t.number)}: ${t.subject}`, input.body);
    return this.getOwn(tenantId, t.id);
  }

  async getOwn(tenantId: string, id: string) {
    const t = await this.db.tenant(tenantId, (tx) => tx.supportTicket.findUnique({
      where: { id },
      select: { ...TICKET, messages: { orderBy: { createdAt: 'asc' }, select: { id: true, authorKind: true, body: true, createdAt: true, author: { select: { name: true } } } } },
    }));
    if (!t) throw new NotFoundException('Caso no encontrado');
    return { ...t, due: responseDue(t) };
  }

  async replyOwn(tenantId: string, userId: string, id: string, input: z.infer<typeof messageSchema>) {
    const t = await this.getOwn(tenantId, id);
    if (t.status === 'CLOSED') throw new ConflictException({ code: 'TICKET_CLOSED', message: 'El caso está cerrado: abre uno nuevo' });
    await this.db.tenant(tenantId, async (tx) => {
      await tx.supportMessage.create({ data: { ticketId: id, tenantId, authorKind: 'CLIENT', authorId: userId, body: input.body } });
      // Responder un caso resuelto o en espera lo vuelve a abrir
      await tx.supportTicket.update({ where: { id }, data: { lastActivityAt: new Date(), ...(t.status === 'WAITING_CLIENT' || t.status === 'RESOLVED' ? { status: 'OPEN', resolvedAt: null } : {}) } });
    });
    await this.notifyStaff(id, `Respuesta del cliente en ${ticketNo(t.number)}: ${t.subject}`, input.body);
    return this.getOwn(tenantId, id);
  }

  /** Encuesta de satisfacción: una vez, al estar resuelto; cierra el caso */
  async rate(tenantId: string, userId: string, id: string, input: z.infer<typeof rateSchema>) {
    const t = await this.getOwn(tenantId, id);
    if (!t.resolvedAt || t.ratedAt) throw new ConflictException({ code: 'NOT_RATABLE', message: t.ratedAt ? 'Ya calificaste este caso' : 'Se califica cuando el caso está resuelto' });
    const now = new Date();
    await this.db.tenant(tenantId, (tx) => tx.supportTicket.update({ where: { id }, data: { rating: input.rating, ratingComment: input.comment || null, ratedAt: now, status: 'CLOSED', closedAt: now, lastActivityAt: now } }));
    await this.audit.system({ tenantId, userId, action: 'support.rated', entityType: 'support_ticket', entityId: id, metadata: { rating: input.rating } });
    return this.getOwn(tenantId, id);
  }

  // ---------------------------------------------------------------- Plataforma

  async list(input: z.infer<typeof listSchema>) {
    const where: Prisma.SupportTicketWhereInput = {
      ...(input.status === 'active' ? { status: { notIn: CLOSED } } : input.status ? { status: input.status } : {}),
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      ...(input.q ? { OR: [{ subject: { contains: input.q, mode: 'insensitive' } }, { tenant: { name: { contains: input.q, mode: 'insensitive' } } }, ...(/^\d+$/.test(input.q) ? [{ number: Number(input.q) }] : [])] } : {}),
    };
    const rows = await this.db.system.supportTicket.findMany({
      where, orderBy: [{ lastActivityAt: 'desc' }], take: 300,
      select: { ...TICKET, tenant: { select: { id: true, name: true, deploymentMode: true } }, assignee: { select: { id: true, name: true } }, _count: { select: { messages: true } } },
    });
    return rows.map((t) => ({ ...t, due: responseDue(t) }));
  }

  async summary() {
    const since = new Date(Date.now() - 90 * 86_400_000);
    const [open, rated, active] = await Promise.all([
      this.db.system.supportTicket.groupBy({ by: ['priority'], where: { status: { notIn: CLOSED } }, _count: true }),
      this.db.system.supportTicket.aggregate({ where: { ratedAt: { gte: since } }, _avg: { rating: true }, _count: { rating: true } }),
      this.db.system.supportTicket.findMany({ where: { status: { notIn: CLOSED } }, select: { priority: true, createdAt: true, firstResponseAt: true, status: true } }),
    ]);
    return {
      open: Object.fromEntries(open.map((g) => [g.priority, g._count])),
      overdue: active.filter((t) => responseDue(t).overdue).length,
      satisfaction: { average: rated._avg.rating, count: rated._count.rating, days: 90 },
    };
  }

  async createForTenant(userId: string, input: z.infer<typeof staffTicketSchema>) {
    const tenant = await this.db.system.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true } });
    if (!tenant) throw new NotFoundException('Empresa no encontrada');
    const t = await this.db.system.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.create({ data: { tenantId: input.tenantId, kind: input.kind, priority: input.priority, subject: input.subject, source: 'PLATFORM', createdById: userId, assigneeId: userId, status: 'IN_PROGRESS', firstResponseAt: new Date() }, select: TICKET });
      await tx.supportMessage.create({ data: { ticketId: ticket.id, tenantId: input.tenantId, authorKind: 'STAFF', authorId: userId, body: input.body } });
      return ticket;
    });
    await this.audit.system({ tenantId: input.tenantId, userId, action: 'support.created', entityType: 'support_ticket', entityId: t.id, metadata: { number: t.number, onBehalf: true } });
    await this.notifyClient(t.id, `Registramos tu caso ${ticketNo(t.number)}: ${t.subject}`, input.body);
    return this.get(t.id);
  }

  async get(id: string) {
    const t = await this.db.system.supportTicket.findUnique({
      where: { id },
      select: {
        ...TICKET, tenant: { select: { id: true, name: true, deploymentMode: true } }, assignee: { select: { id: true, name: true } }, createdBy: { select: { name: true, email: true } },
        provisioningRun: { select: { id: true, number: true, domain: true } },
        messages: { orderBy: { createdAt: 'asc' }, select: { id: true, authorKind: true, body: true, internal: true, createdAt: true, author: { select: { name: true } } } },
      },
    });
    if (!t) throw new NotFoundException('Caso no encontrado');
    return { ...t, due: responseDue(t) };
  }

  async reply(userId: string, id: string, input: z.infer<typeof staffMessageSchema>) {
    const t = await this.get(id);
    if (t.status === 'CLOSED') throw new ConflictException({ code: 'TICKET_CLOSED', message: 'El caso está cerrado' });
    const now = new Date();
    await this.db.system.$transaction(async (tx) => {
      await tx.supportMessage.create({ data: { ticketId: id, tenantId: t.tenantId, authorKind: 'STAFF', authorId: userId, body: input.body, internal: input.internal } });
      if (!input.internal) {
        await tx.supportTicket.update({ where: { id }, data: { lastActivityAt: now, firstResponseAt: t.firstResponseAt ?? now, ...(t.status === 'OPEN' ? { status: 'IN_PROGRESS' } : {}), ...(t.assigneeId ? {} : { assigneeId: userId }) } });
      }
    });
    if (!input.internal) await this.notifyClient(id, `Respuesta a tu caso ${ticketNo(t.number)}: ${t.subject}`, input.body);
    return this.get(id);
  }

  async update(userId: string, id: string, input: z.infer<typeof updateTicketSchema>) {
    const t = await this.get(id);
    if (input.assigneeId) {
      const staff = await this.db.system.user.findFirst({ where: { id: input.assigneeId, role: 'PLATFORM_ADMIN', status: 'ACTIVE' }, select: { id: true } });
      if (!staff) throw new NotFoundException('Responsable no encontrado');
    }
    const now = new Date();
    const to = input.status;
    const data: Prisma.SupportTicketUncheckedUpdateInput = {
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      ...(to && to !== t.status ? {
        status: to, lastActivityAt: now,
        resolvedAt: to === 'RESOLVED' || to === 'CLOSED' ? (t.resolvedAt ?? now) : null,
        closedAt: to === 'CLOSED' ? now : null,
      } : {}),
    };
    await this.db.system.$transaction(async (tx: Tx) => {
      await tx.supportTicket.update({ where: { id }, data });
      if (to && to !== t.status) await tx.supportMessage.create({ data: { ticketId: id, tenantId: t.tenantId, authorKind: 'SYSTEM', authorId: userId, body: `Estado: ${STATUS_LABEL[to]}` } });
    });
    await this.audit.system({ tenantId: t.tenantId, userId, action: 'support.updated', entityType: 'support_ticket', entityId: id, metadata: { ...input } });
    if (to === 'RESOLVED' && t.status !== 'RESOLVED') {
      await this.notifyClient(id, `Resolvimos tu caso ${ticketNo(t.number)}: ${t.subject}`, 'Si quedó resuelto, califica la atención en tu panel (Soporte). Si no, respóndenos y lo reabrimos.');
    }
    return this.get(id);
  }

  // ---------------------------------------------------------------- Incidencias del monitoreo

  /** Una incidencia abierta por instalación que dejó de reportar o enfermó (la crea el worker) */
  async openMonitorIncident(runId: string, subject: string, text: string) {
    const run = await this.db.system.provisioningRun.findUnique({ where: { id: runId }, select: { installationOrder: { select: { tenantId: true } } } });
    const tenantId = run?.installationOrder.tenantId;
    if (!tenantId) return null;
    const existing = await this.db.system.supportTicket.findFirst({ where: { provisioningRunId: runId, source: 'MONITOR', status: { notIn: CLOSED } }, select: { id: true } });
    if (existing) {
      await this.db.system.supportMessage.create({ data: { ticketId: existing.id, tenantId, authorKind: 'SYSTEM', body: text } });
      return existing.id;
    }
    const t = await this.db.system.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.create({ data: { tenantId, kind: 'INCIDENT', priority: 'HIGH', subject, source: 'MONITOR', provisioningRunId: runId }, select: { id: true, number: true } });
      await tx.supportMessage.create({ data: { ticketId: ticket.id, tenantId, authorKind: 'SYSTEM', body: text } });
      return ticket;
    });
    await this.audit.system({ tenantId, userId: null, action: 'support.incident_opened', entityType: 'support_ticket', entityId: t.id, metadata: { runId } });
    return t.id;
  }

  /** La instalación volvió a reportar sana: la incidencia automática queda resuelta */
  async resolveMonitorIncident(runId: string) {
    const open = await this.db.system.supportTicket.findFirst({ where: { provisioningRunId: runId, source: 'MONITOR', status: { notIn: CLOSED } }, select: { id: true, tenantId: true } });
    if (!open) return;
    const now = new Date();
    await this.db.system.$transaction(async (tx) => {
      await tx.supportMessage.create({ data: { ticketId: open.id, tenantId: open.tenantId, authorKind: 'SYSTEM', body: 'La instalación volvió a reportar con servicios sanos.' } });
      await tx.supportTicket.update({ where: { id: open.id }, data: { status: 'RESOLVED', resolvedAt: now, lastActivityAt: now } });
    });
  }

  // ---------------------------------------------------------------- Avisos

  private async notifyStaff(ticketId: string, subject: string, text: string) {
    const admins = await this.db.system.user.findMany({ where: { role: 'PLATFORM_ADMIN', status: 'ACTIVE' }, select: { email: true } });
    const url = `${this.env.APP_PUBLIC_URL}/plataforma/soporte/${ticketId}`;
    for (const a of admins) await this.mail.send({ to: a.email, subject, text: `${text.slice(0, 2000)}\n\nAtender: ${url}\n` }).catch(() => false);
  }

  private async notifyClient(ticketId: string, subject: string, text: string) {
    const t = await this.db.system.supportTicket.findUniqueOrThrow({ where: { id: ticketId }, select: { tenantId: true, createdBy: { select: { email: true, role: true, status: true } } } });
    const admins = await this.db.system.user.findMany({ where: { tenantId: t.tenantId, role: 'TENANT_ADMIN', status: 'ACTIVE' }, select: { email: true } });
    const to = new Set(admins.map((a) => a.email));
    if (t.createdBy && t.createdBy.role !== 'PLATFORM_ADMIN' && t.createdBy.status === 'ACTIVE') to.add(t.createdBy.email);
    const url = `${this.env.APP_PUBLIC_URL}/soporte/${ticketId}`;
    for (const email of to) await this.mail.send({ to: email, subject, text: `${text.slice(0, 2000)}\n\nVer el caso: ${url}\n` }).catch(() => false);
  }
}
