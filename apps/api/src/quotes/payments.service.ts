import { timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { money } from '../common/pagination.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import type { PaymentMethod, Prisma } from '../generated/prisma/client.js';
import { logSalesActivity } from '../sales/sales.service.js';
import { BEFORE_PAYMENT, advanceLead, dateLima, newAccessToken, sha256, todayLima } from './lead-stage.js';
import { applyTax, cents, fromCents } from './money.js';
import { installNo, orderNo, quoteNo } from './quote-pdf.js';

const METHODS = ['YAPE', 'PLIN', 'BANK_TRANSFER', 'CASH', 'OTHER'] as const;
const opt = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();

export const methodSchema = z.object({
  kind: z.enum(METHODS),
  name: z.string().trim().min(1).max(120),
  /** Datos para pagar (número de Yape, cuenta y CCI…): los escribe la plataforma */
  instructions: z.string().trim().min(5).max(4000),
  countries: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).max(50).default([]),
  currencies: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)).max(20).default([]),
  isActive: z.boolean().default(true),
  sort: z.number().int().min(0).max(10_000).default(0),
});

export const proofSchema = z.object({
  methodId: z.uuid(),
  reference: z.string().trim().min(3, 'Escribe el número de operación').max(120),
  payer: z.string().trim().min(2).max(160),
  paidAt: z.iso.date(),
  amount: money,
  note: opt(1000),
});

export const validateSchema = z.object({
  method: z.enum(METHODS),
  reference: z.string().trim().min(1).max(120),
  paidAt: z.coerce.date(),
  amount: money,
  /** Quien valida declara haber visto el dinero en la cuenta (no solo el comprobante) */
  verifiedInAccount: z.literal(true, { error: 'Confirma que viste el ingreso en la cuenta' }),
  note: opt(2000),
});
export const reasonSchema = z.object({ reason: z.string().trim().min(3).max(1000) });
export const allowedMethodsSchema = z.object({ methodIds: z.array(z.uuid()).max(20) });

type Validation = { method: PaymentMethod; reference: string; paidAt: Date; note?: string | null };

/**
 * Órdenes de pago de nuestras ventas (ADR 049). Un comprobante del cliente es
 * solo una declaración: la orden pasa a pagada únicamente con la validación de
 * una persona de la plataforma (que declara haber visto el ingreso en la cuenta)
 * o con la confirmación de una pasarela oficial. Al pagarse se registra el
 * asiento de ingreso y nace la orden de instalación, en la misma transacción.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // ---- Métodos de pago ----

  methods() {
    return this.db.system.paymentMethodConfig.findMany({ orderBy: [{ sort: 'asc' }, { name: 'asc' }] });
  }

  async createMethod(userId: string, input: z.infer<typeof methodSchema>) {
    const m = await this.db.system.paymentMethodConfig.create({ data: input });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.payment_method_created', entityType: 'payment_method', entityId: m.id, metadata: { kind: m.kind, name: m.name } });
    return m;
  }

  async updateMethod(userId: string, id: string, input: z.infer<typeof methodSchema>) {
    if (!(await this.db.system.paymentMethodConfig.findUnique({ where: { id } }))) throw new NotFoundException('Método no encontrado');
    const m = await this.db.system.paymentMethodConfig.update({ where: { id }, data: input });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.payment_method_updated', entityType: 'payment_method', entityId: id, metadata: { isActive: m.isActive } });
    return m;
  }

  /** Métodos activos que corresponden a la orden (país, moneda y, si se eligieron, los del cliente) */
  private async methodsFor(o: { country: string | null; currency: string; allowedMethodIds: string[] }) {
    const all = await this.db.system.paymentMethodConfig.findMany({ where: { isActive: true }, orderBy: [{ sort: 'asc' }, { name: 'asc' }] });
    return all.filter(
      (m) => (o.allowedMethodIds.length ? o.allowedMethodIds.includes(m.id) : true) && (!m.countries.length || (o.country && m.countries.includes(o.country))) && (!m.currencies.length || m.currencies.includes(o.currency)),
    );
  }

  // ---- Órdenes ----

  /** Orden de pago al aceptar una cotización (dentro de su transacción). Una sola vigente por cotización. */
  async createForQuote(tx: Tx, q: { id: string; number: number; leadId: string; currency: string; country: string | null; amount: string; initialPayment: string }, userId: string | null) {
    const { token, hash } = newAccessToken();
    const concept = `Propuesta ${quoteNo(q.number)}: ${q.initialPayment === 'ONE_TIME' ? 'pago único' : 'pago único y primera mensualidad'}`;
    const o = await tx.salesPaymentOrder.create({ data: { leadId: q.leadId, quoteId: q.id, concept, amount: q.amount, currency: q.currency, country: q.country, accessTokenHash: hash, createdById: userId }, select: { id: true, number: true } });
    await tx.salesPaymentEvent.create({ data: { orderId: o.id, type: 'CREATED', data: { quoteId: q.id, amount: q.amount, currency: q.currency }, userId } });
    await logSalesActivity(tx, q.leadId, userId, 'NOTE', `Orden de pago ${orderNo(o.number)} por ${q.currency} ${q.amount}`, { paymentOrderId: o.id });
    return { ...o, path: `/pago/${o.id}?t=${token}` };
  }

  list(f: { status?: string; leadId?: string }) {
    return this.db.system.salesPaymentOrder.findMany({
      where: { ...(f.status ? { status: f.status as never } : {}), ...(f.leadId ? { leadId: f.leadId } : {}) },
      orderBy: { number: 'desc' },
      take: 200,
      select: {
        id: true, number: true, concept: true, amount: true, currency: true, status: true, proofSubmittedAt: true, paidAt: true, createdAt: true,
        lead: { select: { id: true, number: true, name: true, company: true } }, quote: { select: { id: true, number: true } },
      },
    });
  }

  async get(id: string) {
    const o = await this.db.system.salesPaymentOrder.findUnique({
      where: { id },
      include: {
        lead: { select: { id: true, number: true, name: true, company: true, status: true } },
        quote: { select: { id: true, number: true } },
        events: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
        accounting: true,
        installation: { select: { id: true, number: true, status: true } },
      },
    });
    if (!o) throw new NotFoundException('Orden de pago no encontrada');
    const { accessTokenHash: _h, ...rest } = o;
    const methods = await this.db.system.paymentMethodConfig.findMany({ select: { id: true, name: true, kind: true } });
    return { ...rest, methods };
  }

  async relink(userId: string, id: string) {
    const o = await this.db.system.salesPaymentOrder.findUnique({ where: { id }, select: { status: true } });
    if (!o) throw new NotFoundException('Orden de pago no encontrada');
    if (o.status === 'PAID' || o.status === 'CANCELLED') throw new ConflictException({ code: 'ORDER_CLOSED', message: 'La orden ya está cerrada' });
    const { token, hash } = newAccessToken();
    await this.db.system.$transaction(async (tx) => {
      await tx.salesPaymentOrder.update({ where: { id }, data: { accessTokenHash: hash } });
      await tx.salesPaymentEvent.create({ data: { orderId: id, type: 'LINK_RENEWED', userId } });
    });
    return { path: `/pago/${id}?t=${token}` };
  }

  async setAllowedMethods(userId: string, id: string, methodIds: string[]) {
    const o = await this.db.system.salesPaymentOrder.findUnique({ where: { id }, select: { status: true } });
    if (!o) throw new NotFoundException('Orden de pago no encontrada');
    if (o.status === 'PAID' || o.status === 'CANCELLED') throw new ConflictException({ code: 'ORDER_CLOSED', message: 'La orden ya está cerrada' });
    if (methodIds.length && (await this.db.system.paymentMethodConfig.count({ where: { id: { in: methodIds } } })) !== new Set(methodIds).size) throw new BadRequestException('Método de pago desconocido');
    await this.db.system.$transaction(async (tx) => {
      await tx.salesPaymentOrder.update({ where: { id }, data: { allowedMethodIds: methodIds } });
      await tx.salesPaymentEvent.create({ data: { orderId: id, type: 'METHODS_SET', data: { methodIds }, userId } });
    });
    return this.get(id);
  }

  async cancel(userId: string, id: string, reason: string) {
    const o = await this.db.system.salesPaymentOrder.findUnique({ where: { id }, select: { status: true, number: true, leadId: true } });
    if (!o) throw new NotFoundException('Orden de pago no encontrada');
    if (o.status === 'PAID') throw new ConflictException({ code: 'ORDER_PAID', message: 'Una orden pagada no se anula (el ingreso ya está registrado)' });
    if (o.status === 'CANCELLED') throw new ConflictException({ code: 'ORDER_CLOSED', message: 'La orden ya está anulada' });
    await this.db.system.$transaction(async (tx) => {
      const r = await tx.salesPaymentOrder.updateMany({ where: { id, status: { in: ['PENDING', 'PROOF_SUBMITTED'] } }, data: { status: 'CANCELLED', cancelReason: reason } });
      if (r.count !== 1) throw new ConflictException({ code: 'STALE_ORDER', message: 'La orden cambió: recarga' });
      await tx.salesPaymentEvent.create({ data: { orderId: id, type: 'CANCELLED', data: { reason }, userId } });
      await logSalesActivity(tx, o.leadId, userId, 'NOTE', `Orden de pago ${orderNo(o.number)} anulada: ${reason}`, { paymentOrderId: id });
    });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.payment_order_cancelled', entityType: 'payment_order', entityId: id, metadata: { reason } });
    return this.get(id);
  }

  async rejectProof(userId: string, id: string, reason: string) {
    const o = await this.db.system.salesPaymentOrder.findUnique({ where: { id }, select: { status: true, number: true, leadId: true } });
    if (!o) throw new NotFoundException('Orden de pago no encontrada');
    if (o.status !== 'PROOF_SUBMITTED') throw new ConflictException({ code: 'NO_PROOF', message: 'No hay un comprobante por revisar' });
    await this.db.system.$transaction(async (tx) => {
      await tx.salesPaymentOrder.update({ where: { id }, data: { status: 'PENDING' } });
      await tx.salesPaymentEvent.create({ data: { orderId: id, type: 'PROOF_REJECTED', data: { reason }, userId } });
      await logSalesActivity(tx, o.leadId, userId, 'NOTE', `Comprobante de ${orderNo(o.number)} no validado: ${reason}`, { paymentOrderId: id });
    });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.payment_proof_rejected', entityType: 'payment_order', entityId: id, metadata: { reason } });
    return this.get(id);
  }

  /** Validación administrativa: el importe debe coincidir y quien valida declara haber visto el ingreso */
  async validate(userId: string, id: string, input: z.infer<typeof validateSchema>) {
    const o = await this.db.system.salesPaymentOrder.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Orden de pago no encontrada');
    if (o.status === 'PAID') throw new ConflictException({ code: 'ORDER_PAID', message: 'La orden ya está pagada' });
    if (o.status === 'CANCELLED') throw new ConflictException({ code: 'ORDER_CLOSED', message: 'La orden está anulada' });
    if (cents(input.amount) !== cents(o.amount)) throw new BadRequestException({ code: 'AMOUNT_MISMATCH', message: `El importe validado (${input.amount}) no coincide con la orden (${o.amount.toFixed(2)})` });
    if (input.paidAt.getTime() > Date.now() + 60_000) throw new BadRequestException('La fecha del pago no puede ser futura');
    const r = await this.db.system.$transaction((tx) => this.markPaid(tx, o.id, { method: input.method, reference: input.reference, paidAt: input.paidAt, note: input.note }, userId, null));
    await this.audit.system({ tenantId: null, userId, action: 'commercial.payment_validated', entityType: 'payment_order', entityId: id, metadata: { amount: o.amount.toFixed(2), currency: o.currency, method: input.method, reference: input.reference, verifiedInAccount: true, installationOrder: r.installation } });
    return this.get(id);
  }

  /**
   * Pago registrado desde la ficha del prospecto, sin cotización (lo que hacía la
   * fase A): crea la orden y la valida en un paso, con su asiento e instalación.
   */
  async registerManual(userId: string, leadId: string, input: { amount: string; currency: string; method: PaymentMethod; reference: string; paidAt: Date; note?: string | null }) {
    const open = await this.db.system.salesPaymentOrder.findFirst({ where: { leadId, status: { in: ['PENDING', 'PROOF_SUBMITTED'] } }, select: { number: true } });
    if (open) throw new ConflictException({ code: 'OPEN_PAYMENT_ORDER', message: `El prospecto tiene la orden ${orderNo(open.number)} abierta: valida el pago desde esa orden` });
    const id = await this.db.system.$transaction(async (tx) => {
      const o = await tx.salesPaymentOrder.create({ data: { leadId, concept: 'Pago registrado por el equipo', amount: input.amount, currency: input.currency, createdById: userId }, select: { id: true } });
      await tx.salesPaymentEvent.create({ data: { orderId: o.id, type: 'CREATED', data: { manual: true }, userId } });
      await this.markPaid(tx, o.id, { method: input.method, reference: input.reference, paidAt: input.paidAt, note: input.note }, userId, null);
      return o.id;
    });
    return id;
  }

  /**
   * Confirmación de una pasarela oficial (ADR 049). Idempotente por (proveedor,
   * evento): un reenvío no cobra ni instala dos veces. Solo la llama el adaptador
   * de la pasarela después de verificar la firma de su webhook; hoy no hay
   * ninguna pasarela conectada, por eso no existe la ruta pública.
   */
  async confirmFromGateway(provider: string, eventId: string, p: { orderId: string; amount: string; currency: string; paymentId: string; paidAt: Date }) {
    return this.db.system.$transaction(async (tx) => {
      const seen = await tx.paymentGatewayEvent.findUnique({ where: { provider_eventId: { provider, eventId } } });
      if (seen) return { duplicate: true, outcome: seen.outcome };
      const o = await tx.salesPaymentOrder.findUnique({ where: { id: p.orderId } });
      let outcome = 'PAID';
      if (!o) outcome = 'UNKNOWN_ORDER';
      else if (o.status === 'PAID') outcome = 'ALREADY_PAID';
      else if (o.status === 'CANCELLED') outcome = 'ORDER_CANCELLED';
      else if (cents(p.amount) !== cents(o.amount) || p.currency !== o.currency) outcome = 'AMOUNT_MISMATCH';
      await tx.paymentGatewayEvent.create({ data: { provider, eventId, orderId: o?.id ?? null, outcome } });
      if (outcome === 'PAID') {
        await tx.salesPaymentOrder.update({ where: { id: o!.id }, data: { gatewayProvider: provider, gatewayPaymentId: p.paymentId } });
        await this.markPaid(tx, o!.id, { method: 'OTHER', reference: p.paymentId, paidAt: p.paidAt }, null, provider);
      } else if (o) {
        await tx.salesPaymentEvent.create({ data: { orderId: o.id, type: 'GATEWAY_IGNORED', data: { provider, eventId, outcome } } });
      }
      return { duplicate: false, outcome };
    });
  }

  /** Pagado → asiento de ingreso, orden de instalación y etapa del prospecto (misma transacción) */
  private async markPaid(tx: Tx, id: string, v: Validation, userId: string | null, gateway: string | null) {
    const o = await tx.salesPaymentOrder.findUniqueOrThrow({ where: { id }, include: { quote: true, lead: { select: { status: true } } } });
    if (o.lead.status === 'LOST') throw new ConflictException({ code: 'LEAD_LOST', message: 'El prospecto está marcado como perdido: reábrelo antes de validar el pago' });
    const now = new Date();
    const r = await tx.salesPaymentOrder.updateMany({
      where: { id, status: { in: ['PENDING', 'PROOF_SUBMITTED'] } },
      data: { status: 'PAID', paidAt: v.paidAt, method: v.method, reference: v.reference, validatedAt: now, validatedById: userId },
    });
    if (r.count !== 1) throw new ConflictException({ code: 'STALE_ORDER', message: 'La orden cambió mientras se validaba: recarga' });
    await tx.salesPaymentEvent.create({ data: { orderId: id, type: gateway ? 'GATEWAY_CONFIRMED' : 'VALIDATED', data: { method: v.method, reference: v.reference, paidAt: v.paidAt.toISOString(), verifiedInAccount: !gateway, gateway, note: v.note ?? null }, userId } });

    // Impuesto del asiento: el de la cotización; sin cotización, el configurado (el importe cobrado lo incluye)
    let tax = 0;
    if (o.quote) tax = cents(o.quote.taxOneTime) + (o.quote.initialPayment === 'ONE_TIME_AND_FIRST_MONTH' ? cents(o.quote.taxMonthly) : 0);
    else {
      const s = await tx.commercialSettings.findUnique({ where: { id: 1 }, select: { taxName: true, taxRate: true } });
      tax = applyTax(cents(o.amount), { name: s?.taxName ?? null, rate: s?.taxRate?.toString() ?? null, included: true }).tax;
    }
    const gross = cents(o.amount);
    await tx.accountingEntry.create({
      data: {
        entryDate: new Date(`${dateLima(v.paidAt)}T00:00:00Z`), kind: 'INCOME', leadId: o.leadId, paymentOrderId: id,
        description: `${orderNo(o.number)} · ${o.concept}`, currency: o.currency, gross: fromCents(gross), tax: fromCents(tax), net: fromCents(gross - tax),
        method: v.method, reference: v.reference, createdById: userId,
      },
    });
    const inst = await tx.installationOrder.create({
      data: {
        leadId: o.leadId, quoteId: o.quoteId, paymentOrderId: id, deploymentMode: o.quote?.deploymentMode ?? null, planCode: o.quote?.planCode ?? null, users: o.quote?.users ?? null,
        modules: o.quote?.modules ?? [], serverResources: o.quote?.serverResources ?? null, notes: o.quote?.initialSetup ?? null,
      },
      select: { id: true, number: true },
    });
    const data = { paymentOrderId: id, amount: o.amount.toFixed(2), currency: o.currency, method: v.method, reference: v.reference, paidAt: v.paidAt.toISOString(), verifiedInAccount: !gateway, gateway, installationOrder: installNo(inst.number) };
    await logSalesActivity(tx, o.leadId, userId, 'PAYMENT_VALIDATED', v.note ?? null, data as Prisma.InputJsonObject);
    await advanceLead(tx, o.leadId, 'PAYMENT_CONFIRMED', ['PAYMENT_PENDING', ...BEFORE_PAYMENT], gateway ? 'gateway' : 'payment_validated', userId);
    await tx.salesLead.update({ where: { id: o.leadId }, data: { nextAction: `Instalar: orden ${installNo(inst.number)}`, nextActionAt: now } });
    return { installation: installNo(inst.number) };
  }

  // ---- Cliente (enlace) ----

  async publicView(id: string, token: string) {
    const o = await this.authorized(id, token);
    const methods = o.status === 'PAID' || o.status === 'CANCELLED' ? [] : await this.methodsFor(o);
    const s = await this.db.system.commercialSettings.findUnique({ where: { id: 1 }, select: { legalName: true, contactEmail: true, contactWhatsapp: true } });
    return {
      code: orderNo(o.number), concept: o.concept, amount: o.amount.toFixed(2), currency: o.currency, status: o.status, proofSubmittedAt: o.proofSubmittedAt, paidAt: o.paidAt,
      quote: o.quote ? { code: quoteNo(o.quote.number) } : null,
      methods: methods.map((m) => ({ id: m.id, kind: m.kind, name: m.name, instructions: m.instructions })),
      issuer: s ? { legalName: s.legalName, email: s.contactEmail, whatsapp: s.contactWhatsapp } : null,
    };
  }

  async submitProof(id: string, token: string, input: z.infer<typeof proofSchema>) {
    const o = await this.authorized(id, token);
    if (o.status === 'PAID') throw new ConflictException({ code: 'ORDER_PAID', message: 'Esta orden ya está pagada' });
    if (o.status === 'CANCELLED') throw new ConflictException({ code: 'ORDER_CLOSED', message: 'Esta orden fue anulada' });
    if (!(await this.methodsFor(o)).some((m) => m.id === input.methodId)) throw new BadRequestException({ code: 'METHOD_NOT_ALLOWED', message: 'Ese método de pago no está disponible para esta orden' });
    if (input.paidAt > todayLima()) throw new BadRequestException('La fecha del pago no puede ser futura');
    await this.db.system.$transaction(async (tx) => {
      await tx.salesPaymentOrder.update({ where: { id }, data: { status: 'PROOF_SUBMITTED', proof: input, proofSubmittedAt: new Date() } });
      await tx.salesPaymentEvent.create({ data: { orderId: id, type: 'PROOF_SUBMITTED', data: input } });
      await logSalesActivity(tx, o.leadId, null, 'NOTE', `El cliente informó el pago de ${orderNo(o.number)}: ${o.currency} ${input.amount}, operación ${input.reference} (falta validarlo en la cuenta)`, { paymentOrderId: id, by: 'client' });
      await tx.salesLead.update({ where: { id: o.leadId }, data: { nextAction: `Validar pago ${orderNo(o.number)} en la cuenta`, nextActionAt: new Date() } });
    });
    return { ok: true };
  }

  private async authorized(id: string, token: string) {
    const o = await this.db.system.salesPaymentOrder.findUnique({ where: { id }, include: { quote: { select: { number: true } } } });
    const ok = o?.accessTokenHash && token.length >= 20 && timingSafeEqual(Buffer.from(o.accessTokenHash, 'hex'), Buffer.from(sha256(token), 'hex'));
    if (!o || !ok) throw new NotFoundException({ code: 'ORDER_LINK', message: 'El enlace no es válido o fue reemplazado. Pide uno nuevo a tu asesor.' });
    return o;
  }

  // ---- Contabilidad e instalaciones ----

  async ledger(f: { from?: string; to?: string }) {
    const where = { entryDate: { ...(f.from ? { gte: new Date(`${f.from}T00:00:00Z`) } : {}), ...(f.to ? { lte: new Date(`${f.to}T00:00:00Z`) } : {}) } };
    const [rows, sums] = await Promise.all([
      this.db.system.accountingEntry.findMany({ where, orderBy: { number: 'desc' }, take: 500, include: { lead: { select: { id: true, number: true, name: true, company: true } } } }),
      this.db.system.accountingEntry.groupBy({ by: ['currency'], where, _sum: { gross: true, tax: true, net: true }, _count: true }),
    ]);
    return { entries: rows, totals: sums.map((s) => ({ currency: s.currency, count: s._count, gross: s._sum.gross?.toFixed(2) ?? '0.00', tax: s._sum.tax?.toFixed(2) ?? '0.00', net: s._sum.net?.toFixed(2) ?? '0.00' })) };
  }

  async ledgerCsv(f: { from?: string; to?: string }) {
    const { entries } = await this.ledger(f);
    const esc = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const head = ['Asiento', 'Fecha', 'Cliente', 'Descripción', 'Moneda', 'Bruto', 'Impuesto', 'Neto', 'Medio', 'Operación'];
    const body = entries.map((e) => [`AS-${String(e.number).padStart(5, '0')}`, e.entryDate.toISOString().slice(0, 10), e.lead ? (e.lead.company ?? e.lead.name) : '', e.description, e.currency, e.gross.toFixed(2), e.tax.toFixed(2), e.net.toFixed(2), e.method ?? '', e.reference ?? ''].map((v) => esc(String(v))).join(','));
    return `﻿${[head.join(','), ...body].join('\n')}\n`;
  }

  installations(f: { status?: string }) {
    return this.db.system.installationOrder.findMany({
      where: f.status ? { status: f.status as never } : {},
      orderBy: { number: 'desc' },
      take: 200,
      include: { lead: { select: { id: true, number: true, name: true, company: true, status: true } }, quote: { select: { id: true, number: true } }, paymentOrder: { select: { id: true, number: true } }, tenant: { select: { id: true, name: true, status: true } } },
    });
  }

  async setInstallationStatus(userId: string, id: string, status: 'IN_PROGRESS' | 'DONE' | 'CANCELLED', note: string | null) {
    const i = await this.db.system.installationOrder.findUnique({ where: { id } });
    if (!i) throw new NotFoundException('Orden de instalación no encontrada');
    const allowed: Record<string, string[]> = { AUTHORIZED: ['IN_PROGRESS', 'CANCELLED'], IN_PROGRESS: ['DONE', 'CANCELLED'], DONE: [], CANCELLED: [] };
    if (!allowed[i.status]!.includes(status)) throw new ConflictException({ code: 'BAD_TRANSITION', message: 'Ese cambio de estado no está permitido' });
    if (status === 'DONE' && !i.tenantId) throw new ConflictException({ code: 'NO_TENANT', message: 'Primero convierte el prospecto en cliente (crea su empresa)' });
    await this.db.system.$transaction(async (tx) => {
      await tx.installationOrder.update({ where: { id }, data: { status, notes: note ? `${i.notes ? `${i.notes}\n` : ''}${note}` : i.notes } });
      await logSalesActivity(tx, i.leadId, userId, 'NOTE', `Orden ${installNo(i.number)}: ${status === 'IN_PROGRESS' ? 'en curso' : status === 'DONE' ? 'terminada' : 'cancelada'}${note ? ` · ${note}` : ''}`, { installationOrderId: id });
    });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.installation_status', entityType: 'installation_order', entityId: id, metadata: { from: i.status, to: status } });
    return this.installations({});
  }

  webUrl() {
    return this.env.APP_PUBLIC_URL.replace(/\/$/, '');
  }
}
