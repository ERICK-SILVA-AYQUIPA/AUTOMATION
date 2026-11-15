import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { money } from '../common/pagination.js';
import { MODULES } from '../common/decorators/module.decorator.js';
import { TEMPLATE_KEYS } from '../templates/catalog.js';
import type { Prisma, SalesActivityType, SalesLeadStatus } from '../generated/prisma/client.js';

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'DEMO_REQUESTED', 'QUOTE_SENT', 'NEGOTIATION', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'INSTALLATION_PENDING', 'ACTIVE_CLIENT', 'LOST'] as const satisfies readonly SalesLeadStatus[];
/** Etapas que el equipo mueve a mano. Las demás las fija el sistema (pago validado, conversión, activación). */
export const MANUAL_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'DEMO_REQUESTED', 'QUOTE_SENT', 'NEGOTIATION', 'PAYMENT_PENDING', 'LOST'] as const satisfies readonly SalesLeadStatus[];
const OPEN_EXCLUDED: SalesLeadStatus[] = ['ACTIVE_CLIENT', 'LOST'];
export const LEAD_SOURCES = ['WEBSITE', 'WHATSAPP', 'REFERRAL', 'SOCIAL', 'EVENT', 'OUTBOUND', 'OTHER'] as const;
export const SECTORS = [...TEMPLATE_KEYS, 'OTHER'] as const;
const MANUAL_ACTIVITIES = ['NOTE', 'CALL', 'WHATSAPP', 'EMAIL', 'MEETING'] as const;

/** Teléfono: solo dígitos con «+» opcional (se quitan espacios, guiones y paréntesis) */
const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s().-]/g, ''))
  .refine((v) => /^\+?\d{6,20}$/.test(v), 'Teléfono no válido');
const opt = <T extends z.ZodType>(s: T) => s.nullable().optional();
const text = (max: number) => z.string().trim().min(1).max(max);

const leadFields = {
  name: text(120),
  company: opt(text(160)),
  phone: opt(phone),
  email: opt(z.email().max(200).transform((e) => e.toLowerCase())),
  sector: opt(z.enum(SECTORS)),
  need: opt(text(4000)),
  source: z.enum(LEAD_SOURCES),
  sourceDetail: opt(text(200)),
  estimatedBudget: opt(money),
  budgetCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Moneda de 3 letras (PEN, USD…)').optional(),
  interestMode: opt(z.enum(['SAAS', 'DEDICATED', 'CUSTOM'])),
  interestPlan: opt(z.enum(['BASIC', 'PROFESSIONAL', 'ENTERPRISE'])),
  interestModules: z.array(z.enum(MODULES)).max(MODULES.length).optional(),
};
export const createLeadSchema = z
  .object({ ...leadFields, ownerId: opt(z.uuid()), nextAction: opt(text(300)), nextActionAt: opt(z.coerce.date()), allowDuplicate: z.boolean().optional() })
  .refine((v) => v.phone || v.email, { message: 'Indica un teléfono o un correo', path: ['phone'] })
  .refine((v) => !v.nextAction === !v.nextActionAt, { message: 'La próxima acción necesita texto y fecha', path: ['nextActionAt'] });
export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export const updateLeadSchema = z.object(leadFields).partial().refine((v) => Object.keys(v).length > 0, 'Nada que cambiar');
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export const statusSchema = z.object({ status: z.enum(LEAD_STATUSES), note: opt(text(2000)), lostReason: opt(text(500)) });
export const ownerSchema = z.object({ ownerId: z.uuid().nullable() });
export const nextActionSchema = z.object({ text: text(300), dueAt: z.coerce.date() });
export const nextActionDoneSchema = z.object({ note: opt(text(2000)) });
export const activitySchema = z.object({ type: z.enum(MANUAL_ACTIVITIES), body: text(5000) });
/** Validación administrativa del pago (ADR 047). Un comprobante enviado por el cliente no basta. */
export const paymentSchema = z.object({
  amount: money.refine((v) => Number(v) > 0, 'El importe debe ser mayor que 0'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  method: z.enum(['YAPE', 'PLIN', 'BANK_TRANSFER', 'CASH', 'OTHER']),
  reference: text(120),
  paidAt: z.coerce.date(),
  /** Quien valida declara haber visto el dinero en la cuenta (no solo el comprobante) */
  verifiedInAccount: z.literal(true, { error: 'Confirma que viste el ingreso en la cuenta' }),
  note: opt(text(2000)),
});
export const listSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  ownerId: z.union([z.uuid(), z.literal('none')]).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  sector: z.enum(SECTORS).optional(),
  q: z.string().trim().max(100).optional(),
  /** overdue: próxima acción vencida; today: vence hoy o antes; open: sin cerrar */
  view: z.enum(['open', 'overdue', 'all']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListInput = z.infer<typeof listSchema>;

const leadSelect = {
  id: true, number: true, name: true, company: true, phone: true, email: true, sector: true, need: true, source: true, sourceDetail: true,
  estimatedBudget: true, budgetCurrency: true, interestMode: true, interestPlan: true, interestModules: true, status: true,
  ownerId: true, nextAction: true, nextActionAt: true, lostReason: true, tenantId: true, convertedAt: true, statusChangedAt: true, createdAt: true, updatedAt: true,
  owner: { select: { id: true, name: true, email: true } },
} satisfies Prisma.SalesLeadSelect;

/**
 * Centro comercial (ADR 047): prospectos de AI Sales Assistant, embudo e
 * historial. Todo pasa por el rol de sistema; cada cambio queda en el historial
 * del prospecto (solo anexar) y en la auditoría.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  owners() {
    return this.db.system.user.findMany({ where: { tenantId: null, role: 'PLATFORM_ADMIN', status: 'ACTIVE' }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } });
  }

  async create(actorId: string, input: CreateLeadInput) {
    const { allowDuplicate, ownerId, nextAction, nextActionAt, ...fields } = input;
    if (!allowDuplicate) {
      const matches = await this.duplicates(fields.email ?? null, fields.phone ?? null);
      if (matches.length) throw new ConflictException({ code: 'DUPLICATE_LEAD', message: 'Ya hay un prospecto con ese correo o teléfono', matches });
    }
    const owner = ownerId === undefined ? actorId : ownerId;
    if (owner) await this.assertOwner(owner);
    const lead = await this.db.system.$transaction(async (tx) => {
      const l = await tx.salesLead.create({ data: { ...fields, ownerId: owner, nextAction: nextAction ?? null, nextActionAt: nextActionAt ?? null, createdById: actorId }, select: leadSelect });
      await this.log(tx, l.id, actorId, 'CREATED', null, { source: l.source, ownerId: owner });
      if (nextAction) await this.log(tx, l.id, actorId, 'NEXT_ACTION_SET', nextAction, { dueAt: nextActionAt });
      return l;
    });
    await this.audit.system({ tenantId: null, userId: actorId, action: 'sales.lead_created', entityType: 'sales_lead', entityId: lead.id, metadata: { number: lead.number, source: lead.source } });
    return lead;
  }

  /** Prospectos con el mismo correo o teléfono (para no duplicar) */
  async duplicates(email: string | null, phoneNumber: string | null, exceptId?: string) {
    if (!email && !phoneNumber) return [];
    const digits = phoneNumber?.replace(/^\+/, '');
    return this.db.system.salesLead.findMany({
      where: {
        ...(exceptId ? { id: { not: exceptId } } : {}),
        OR: [...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []), ...(digits ? [{ phone: { in: [digits, `+${digits}`] } }] : [])],
      },
      select: { id: true, number: true, name: true, company: true, status: true },
      take: 5,
    });
  }

  private where(f: Omit<ListInput, 'page' | 'pageSize' | 'status'> & { status?: SalesLeadStatus }): Prisma.SalesLeadWhereInput {
    const now = new Date();
    return {
      ...(f.status ? { status: f.status } : f.view === 'open' || f.view === 'overdue' ? { status: { notIn: OPEN_EXCLUDED } } : {}),
      ...(f.ownerId === 'none' ? { ownerId: null } : f.ownerId ? { ownerId: f.ownerId } : {}),
      ...(f.source ? { source: f.source } : {}),
      ...(f.sector ? { sector: f.sector } : {}),
      ...(f.view === 'overdue' ? { nextActionAt: { lt: now } } : {}),
      ...(f.q
        ? {
            OR: [
              { name: { contains: f.q, mode: 'insensitive' } },
              { company: { contains: f.q, mode: 'insensitive' } },
              { email: { contains: f.q, mode: 'insensitive' } },
              { phone: { contains: f.q.replace(/[\s().-]/g, '') } },
              ...(/^\d{1,9}$/.test(f.q.replace(/^P-?/i, '')) ? [{ number: Number(f.q.replace(/^P-?/i, '')) }] : []),
            ],
          }
        : {}),
    };
  }

  async list(f: ListInput) {
    const where = this.where(f);
    const [items, total] = await Promise.all([
      this.db.system.salesLead.findMany({ where, select: leadSelect, orderBy: [{ nextActionAt: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }], skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
      this.db.system.salesLead.count({ where }),
    ]);
    return { items, total, page: f.page, pageSize: f.pageSize, pages: Math.max(1, Math.ceil(total / f.pageSize)) };
  }

  /** Embudo: cada etapa con su cantidad, el presupuesto estimado por moneda y sus prospectos (máx. 100 por etapa) */
  async board(f: Omit<ListInput, 'page' | 'pageSize' | 'status' | 'view'>) {
    const where = this.where(f);
    const [groups, items] = await Promise.all([
      this.db.system.salesLead.groupBy({ by: ['status', 'budgetCurrency'], where, _count: { _all: true }, _sum: { estimatedBudget: true } }),
      Promise.all(LEAD_STATUSES.map((status) => this.db.system.salesLead.findMany({ where: { ...where, status }, select: leadSelect, orderBy: [{ nextActionAt: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }], take: 100 }))),
    ]);
    return LEAD_STATUSES.map((status, i) => {
      const g = groups.filter((x) => x.status === status);
      return {
        status,
        manual: (MANUAL_STATUSES as readonly string[]).includes(status),
        count: g.reduce((a, x) => a + x._count._all, 0),
        budget: g.filter((x) => x._sum.estimatedBudget !== null).map((x) => ({ currency: x.budgetCurrency, amount: x._sum.estimatedBudget!.toFixed(2) })),
        items: items[i]!,
      };
    });
  }

  async summary() {
    const now = new Date();
    const since90 = new Date(now.getTime() - 90 * 86_400_000);
    const open = { status: { notIn: OPEN_EXCLUDED } };
    const [openCount, overdue, unassigned, budget, won90, lost90, bySource] = await Promise.all([
      this.db.system.salesLead.count({ where: open }),
      this.db.system.salesLead.count({ where: { ...open, nextActionAt: { lt: now } } }),
      this.db.system.salesLead.count({ where: { ...open, ownerId: null } }),
      this.db.system.salesLead.groupBy({ by: ['budgetCurrency'], where: { ...open, estimatedBudget: { not: null } }, _sum: { estimatedBudget: true } }),
      this.db.system.salesLead.count({ where: { status: 'ACTIVE_CLIENT', statusChangedAt: { gte: since90 } } }),
      this.db.system.salesLead.count({ where: { status: 'LOST', statusChangedAt: { gte: since90 } } }),
      this.db.system.salesLead.groupBy({ by: ['source'], _count: { _all: true } }),
    ]);
    return {
      open: openCount, overdue, unassigned,
      openBudget: budget.map((b) => ({ currency: b.budgetCurrency, amount: b._sum.estimatedBudget!.toFixed(2) })),
      /** Cerrados en los últimos 90 días: ganados (cliente activo) y perdidos; la tasa es null si no hay ninguno */
      closed90: { won: won90, lost: lost90, winRate: won90 + lost90 ? Math.round((won90 / (won90 + lost90)) * 1000) / 10 : null },
      bySource: Object.fromEntries(bySource.map((s) => [s.source, s._count._all])),
    };
  }

  async get(id: string) {
    const lead = await this.db.system.salesLead.findUnique({ where: { id }, select: { ...leadSelect, tenant: { select: { id: true, name: true, status: true, activatedAt: true } } } });
    if (!lead) throw new NotFoundException('Prospecto no encontrado');
    const activities = await this.db.system.salesActivity.findMany({ where: { leadId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 300 });
    const userIds = [...new Set(activities.map((a) => a.userId).filter((x): x is string => !!x))];
    const users = userIds.length ? await this.db.system.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const name = new Map(users.map((u) => [u.id, u.name]));
    return { ...lead, activities: activities.map((a) => ({ ...a, userName: a.userId ? (name.get(a.userId) ?? null) : null })) };
  }

  async update(actorId: string, id: string, input: UpdateLeadInput) {
    const before = await this.db.system.salesLead.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Prospecto no encontrado');
    const after = { phone: input.phone !== undefined ? input.phone : before.phone, email: input.email !== undefined ? input.email : before.email };
    if (!after.phone && !after.email) throw new BadRequestException('Indica un teléfono o un correo');
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(input) as [keyof typeof before, unknown][]) {
      const prev = before[k];
      const norm = (x: unknown) => (x === undefined ? null : x !== null && typeof x === 'object' && 'toFixed' in x ? (x as { toFixed(n: number): string }).toFixed(2) : Array.isArray(x) ? x.join(',') : x);
      const vv = typeof v === 'string' && k === 'estimatedBudget' ? Number(v).toFixed(2) : v;
      if (JSON.stringify(norm(prev)) !== JSON.stringify(norm(vv))) changes[k] = { from: norm(prev), to: norm(vv) };
    }
    if (!Object.keys(changes).length) return this.get(id);
    await this.db.system.$transaction(async (tx) => {
      await tx.salesLead.update({ where: { id }, data: input });
      await this.log(tx, id, actorId, 'UPDATED', null, { changes } as Prisma.InputJsonValue);
    });
    return this.get(id);
  }

  /** Cambio de etapa con las reglas del embudo (ver MANUAL_STATUSES) */
  async setStatus(actorId: string, id: string, input: z.infer<typeof statusSchema>) {
    const lead = await this.db.system.salesLead.findUnique({ where: { id }, select: { status: true } });
    if (!lead) throw new NotFoundException('Prospecto no encontrado');
    const { status: to } = input;
    const from = lead.status;
    if (to === from) return this.get(id);
    if (to === 'PAYMENT_CONFIRMED') throw new BadRequestException({ code: 'STATUS_NOT_MANUAL', message: 'El pago se confirma con «Validar pago», después de comprobar el ingreso en la cuenta' });
    if (to === 'INSTALLATION_PENDING' || to === 'ACTIVE_CLIENT') throw new BadRequestException({ code: 'STATUS_NOT_MANUAL', message: 'Esta etapa la fija el sistema al convertir el prospecto en cliente y al activar su empresa' });
    if (from === 'INSTALLATION_PENDING' || from === 'ACTIVE_CLIENT') throw new ConflictException({ code: 'LEAD_CONVERTED', message: 'El prospecto ya es cliente: su estado lo sigue la empresa creada' });
    if (from === 'PAYMENT_CONFIRMED' && to !== 'LOST') throw new ConflictException({ code: 'PAYMENT_CONFIRMED_LOCKED', message: 'Con el pago confirmado solo se puede convertir en cliente o marcar como perdido (con el motivo, p. ej. devolución)' });
    if (to === 'LOST' && !input.lostReason) throw new BadRequestException({ code: 'LOST_REASON_REQUIRED', message: 'Indica el motivo de la pérdida' });
    await this.db.system.$transaction(async (tx) => {
      // Si otro usuario lo movió entre tanto, no se pisa
      const r = await tx.salesLead.updateMany({ where: { id, status: from }, data: { status: to, statusChangedAt: new Date(), lostReason: to === 'LOST' ? input.lostReason! : null } });
      if (r.count !== 1) throw new ConflictException({ code: 'STALE_STATUS', message: 'Otra persona cambió la etapa: recarga y vuelve a intentarlo' });
      await this.log(tx, id, actorId, 'STATUS_CHANGED', input.note ?? (to === 'LOST' ? input.lostReason! : null), { from, to, ...(to === 'LOST' ? { lostReason: input.lostReason } : {}) });
    });
    await this.audit.system({ tenantId: null, userId: actorId, action: 'sales.lead_status_changed', entityType: 'sales_lead', entityId: id, metadata: { from, to } });
    return this.get(id);
  }

  async setOwner(actorId: string, id: string, ownerId: string | null) {
    const lead = await this.db.system.salesLead.findUnique({ where: { id }, select: { ownerId: true } });
    if (!lead) throw new NotFoundException('Prospecto no encontrado');
    if (lead.ownerId === ownerId) return this.get(id);
    if (ownerId) await this.assertOwner(ownerId);
    await this.db.system.$transaction(async (tx) => {
      await tx.salesLead.update({ where: { id }, data: { ownerId } });
      await this.log(tx, id, actorId, 'OWNER_CHANGED', null, { from: lead.ownerId, to: ownerId });
    });
    return this.get(id);
  }

  async setNextAction(actorId: string, id: string, input: z.infer<typeof nextActionSchema>) {
    await this.exists(id);
    await this.db.system.$transaction(async (tx) => {
      await tx.salesLead.update({ where: { id }, data: { nextAction: input.text, nextActionAt: input.dueAt } });
      await this.log(tx, id, actorId, 'NEXT_ACTION_SET', input.text, { dueAt: input.dueAt });
    });
    return this.get(id);
  }

  async completeNextAction(actorId: string, id: string, note: string | null | undefined) {
    const lead = await this.db.system.salesLead.findUnique({ where: { id }, select: { nextAction: true, nextActionAt: true } });
    if (!lead) throw new NotFoundException('Prospecto no encontrado');
    if (!lead.nextAction) throw new BadRequestException({ code: 'NO_NEXT_ACTION', message: 'No hay próxima acción pendiente' });
    await this.db.system.$transaction(async (tx) => {
      await tx.salesLead.update({ where: { id }, data: { nextAction: null, nextActionAt: null } });
      await this.log(tx, id, actorId, 'NEXT_ACTION_DONE', note ?? null, { action: lead.nextAction, dueAt: lead.nextActionAt, late: !!lead.nextActionAt && lead.nextActionAt < new Date() });
    });
    return this.get(id);
  }

  async addActivity(actorId: string, id: string, input: z.infer<typeof activitySchema>) {
    await this.exists(id);
    await this.db.system.$transaction(async (tx) => {
      await this.log(tx, id, actorId, input.type, input.body, {});
      // Registrar un contacto mantiene el prospecto «vivo» en el orden por actualización
      await tx.salesLead.update({ where: { id }, data: { updatedAt: new Date() } });
    });
    return this.get(id);
  }

  /** Validación administrativa del pago: única forma de llegar a «Pago confirmado» por ahora (sin pasarela) */
  async validatePayment(actorId: string, id: string, input: z.infer<typeof paymentSchema>) {
    const lead = await this.db.system.salesLead.findUnique({ where: { id }, select: { status: true } });
    if (!lead) throw new NotFoundException('Prospecto no encontrado');
    if (lead.status !== 'PAYMENT_PENDING') throw new ConflictException({ code: 'NOT_PAYMENT_PENDING', message: 'Solo se valida el pago de un prospecto en «Pendiente de pago»' });
    if (input.paidAt.getTime() > Date.now() + 60_000) throw new BadRequestException('La fecha del pago no puede ser futura');
    const data = { amount: input.amount, currency: input.currency, method: input.method, reference: input.reference, paidAt: input.paidAt.toISOString(), verifiedInAccount: true };
    await this.db.system.$transaction(async (tx) => {
      const r = await tx.salesLead.updateMany({ where: { id, status: 'PAYMENT_PENDING' }, data: { status: 'PAYMENT_CONFIRMED', statusChangedAt: new Date() } });
      if (r.count !== 1) throw new ConflictException({ code: 'STALE_STATUS', message: 'Otra persona cambió la etapa: recarga y vuelve a intentarlo' });
      await this.log(tx, id, actorId, 'PAYMENT_VALIDATED', input.note ?? null, data);
      await this.log(tx, id, actorId, 'STATUS_CHANGED', null, { from: 'PAYMENT_PENDING', to: 'PAYMENT_CONFIRMED' });
    });
    await this.audit.system({ tenantId: null, userId: actorId, action: 'sales.payment_validated', entityType: 'sales_lead', entityId: id, metadata: data });
    return this.get(id);
  }

  /** Datos del prospecto para el asistente de alta (convertir en cliente) */
  async conversionDraft(id: string) {
    const l = await this.db.system.salesLead.findUnique({ where: { id } });
    if (!l) throw new NotFoundException('Prospecto no encontrado');
    if (l.status !== 'PAYMENT_CONFIRMED' || l.tenantId) throw new ConflictException({ code: 'LEAD_NOT_READY', message: 'Solo se convierte en cliente un prospecto con el pago confirmado y sin empresa creada' });
    return {
      leadId: l.id, number: l.number, name: l.company ?? l.name, adminName: l.name, adminEmail: l.email, phone: l.phone, contactEmail: l.email,
      templateKey: l.sector && l.sector !== 'OTHER' ? l.sector : null, deploymentMode: l.interestMode, planCode: l.interestPlan, enabledModules: l.interestModules,
    };
  }

  private async exists(id: string) {
    if (!(await this.db.system.salesLead.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Prospecto no encontrado');
  }

  private async assertOwner(id: string) {
    const u = await this.db.system.user.findUnique({ where: { id }, select: { role: true, tenantId: true, status: true } });
    if (!u || u.role !== 'PLATFORM_ADMIN' || u.tenantId || u.status !== 'ACTIVE') throw new BadRequestException({ code: 'INVALID_OWNER', message: 'El responsable debe ser personal activo de la plataforma' });
  }

  private log(tx: Tx, leadId: string, userId: string | null, type: SalesActivityType, body: string | null, metadata: Prisma.InputJsonValue) {
    return logSalesActivity(tx, leadId, userId, type, body, metadata);
  }
}

/** Anexa una entrada al historial del prospecto (también desde el alta y la activación de empresas) */
export function logSalesActivity(tx: Tx, leadId: string, userId: string | null, type: SalesActivityType, body: string | null, metadata: Prisma.InputJsonValue) {
  return tx.salesActivity.create({ data: { leadId, userId, type, body, metadata } });
}
