import { timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { money } from '../common/pagination.js';
import { MODULES } from '../common/decorators/module.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { MailService } from '../mail/mail.service.js';
import { MODULE_INFO } from '../commercial/catalog.js';
import { logSalesActivity } from '../sales/sales.service.js';
import { EARLY_TO_QUOTE, advanceLead, newAccessToken, sha256, todayLima } from './lead-stage.js';
import { cents, fromCents, lineTotal, quoteTotals } from './money.js';
import { PaymentsService } from './payments.service.js';
import { quoteNo, renderQuotePdf, type QuotePdfData } from './quote-pdf.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const opt = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Moneda de 3 letras (PEN, USD…)');
const KINDS = ['PLAN', 'USERS', 'MODULE', 'SETUP', 'SERVER', 'INTEGRATION', 'SERVICE', 'SUPPORT', 'MAINTENANCE', 'OTHER'] as const;
const PLANS = ['BASIC', 'PROFESSIONAL', 'ENTERPRISE'] as const;

export const itemSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,40}$/, 'Código: letras, números, guion o guion bajo'),
  name: text(160),
  description: opt(1000),
  kind: z.enum(KINDS),
  billing: z.enum(['ONE_TIME', 'MONTHLY']),
  unitPrice: money,
  currency,
  unit: opt(40),
  planCode: z.enum(PLANS).nullable().optional(),
  module: z.enum(MODULES).nullable().optional(),
  isActive: z.boolean().default(true),
  sort: z.number().int().min(0).max(10_000).default(0),
});
export type ItemInput = z.infer<typeof itemSchema>;

export const contractSchema = z.object({ title: text(160), body: z.string().trim().min(50, 'El contrato debe tener su texto completo').max(100_000) });

export const quoteSettingsSchema = z
  .object({
    legalName: opt(200),
    taxId: opt(30),
    address: opt(300),
    taxName: opt(30),
    taxRate: z.union([money, z.null()]).optional(),
    pricesIncludeTax: z.boolean(),
    quoteValidityDays: z.number().int().min(1).max(180),
    quoteTerms: opt(10_000),
  })
  .refine((v) => !!v.taxName === (v.taxRate != null && v.taxRate !== ''), { path: ['taxRate'], message: 'Indica nombre y tasa del impuesto, o ninguno' })
  .refine((v) => v.taxRate == null || (Number(v.taxRate) > 0 && Number(v.taxRate) < 100), { path: ['taxRate'], message: 'Tasa entre 0 y 100' });

const lineSchema = z.object({
  itemId: z.uuid().nullable().optional(),
  kind: z.enum(KINDS),
  billing: z.enum(['ONE_TIME', 'MONTHLY']),
  description: text(500),
  quantity: z.union([z.number(), z.string()]).transform((v) => String(v).trim()).refine((v) => /^\d{1,6}(\.\d{1,2})?$/.test(v) && Number(v) > 0, 'Cantidad inválida'),
  unitPrice: money,
});
export const quoteSchema = z.object({
  currency,
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).nullable().optional(),
  planCode: z.enum(PLANS).nullable().optional(),
  users: z.number().int().min(1).max(100_000).nullable().optional(),
  modules: z.array(z.enum(MODULES)).max(MODULES.length).default([]),
  deploymentMode: z.enum(['SAAS', 'DEDICATED', 'CUSTOM']).nullable().optional(),
  serverResources: opt(1000),
  initialSetup: opt(2000),
  integrations: opt(2000),
  support: opt(1000),
  maintenance: opt(1000),
  notes: opt(4000),
  initialPayment: z.enum(['ONE_TIME', 'ONE_TIME_AND_FIRST_MONTH']).default('ONE_TIME_AND_FIRST_MONTH'),
  validUntil: z.iso.date().nullable().optional(),
  terms: opt(10_000),
  lines: z.array(lineSchema).min(1, 'Agrega al menos un concepto').max(50),
});
export const createQuoteSchema = quoteSchema.extend({ leadId: z.uuid() });
export type QuoteInput = z.infer<typeof quoteSchema>;

export const acceptSchema = z.object({
  name: text(160),
  document: opt(30),
  email: z.union([z.email().max(200), z.literal('')]).optional().transform((v) => v || null),
  contractVersion: z.number().int().positive(),
  accept: z.literal(true, 'Debes aceptar la propuesta y el contrato'),
});
export const rejectSchema = z.object({ reason: opt(1000) });

const PLAN_NAME: Record<string, string> = { BASIC: 'Básico', PROFESSIONAL: 'Profesional', ENTERPRISE: 'Empresarial' };
const moduleNames = (m: string[]) => m.map((k) => MODULE_INFO[k as keyof typeof MODULE_INFO]?.name ?? k);

/**
 * Cotizaciones (ADR 049): se arman con el catálogo comercial, se envían con un
 * enlace para el cliente y quedan congeladas al enviarse (disparador en la base).
 * Aceptar registra quién, cuándo, desde dónde y qué versión del contrato, y genera
 * la orden de pago; nada se activa ni se instala sin el pago validado.
 */
@Injectable()
export class QuotesService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly mail: MailService,
  ) {}

  // ---- Catálogo comercial ----

  items(all = true) {
    return this.db.system.commercialItem.findMany({ where: all ? {} : { isActive: true }, orderBy: [{ sort: 'asc' }, { name: 'asc' }] });
  }

  async createItem(userId: string, input: ItemInput) {
    if (await this.db.system.commercialItem.findUnique({ where: { code: input.code } })) throw new ConflictException({ code: 'DUPLICATE_CODE', message: 'Ya existe un concepto con ese código' });
    const it = await this.db.system.commercialItem.create({ data: { ...input, planCode: input.planCode ?? null, module: input.module ?? null } });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.item_created', entityType: 'commercial_item', entityId: it.id, metadata: { code: it.code, unitPrice: it.unitPrice.toFixed(2), currency: it.currency } });
    return it;
  }

  async updateItem(userId: string, id: string, input: ItemInput) {
    const before = await this.db.system.commercialItem.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Concepto no encontrado');
    if (input.code !== before.code && (await this.db.system.commercialItem.findUnique({ where: { code: input.code } }))) throw new ConflictException({ code: 'DUPLICATE_CODE', message: 'Ya existe un concepto con ese código' });
    const it = await this.db.system.commercialItem.update({ where: { id }, data: { ...input, planCode: input.planCode ?? null, module: input.module ?? null } });
    // Los cambios de precio no tocan cotizaciones ya armadas: cada línea guarda su precio
    await this.audit.system({ tenantId: null, userId, action: 'commercial.item_updated', entityType: 'commercial_item', entityId: id, metadata: { from: before.unitPrice.toFixed(2), to: it.unitPrice.toFixed(2), isActive: it.isActive } });
    return it;
  }

  // ---- Contrato ----

  contracts() {
    return this.db.system.contractVersion.findMany({ orderBy: { version: 'desc' }, select: { id: true, version: true, title: true, body: true, createdAt: true } });
  }

  async createContract(userId: string, input: z.infer<typeof contractSchema>) {
    const last = await this.db.system.contractVersion.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
    const c = await this.db.system.contractVersion.create({ data: { version: (last?.version ?? 0) + 1, title: input.title, body: input.body, createdById: userId } });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.contract_version_created', entityType: 'contract_version', entityId: c.id, metadata: { version: c.version } });
    return c;
  }

  // ---- Emisor e impuestos ----

  async settings() {
    const s = await this.db.system.commercialSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    return { legalName: s.legalName, taxId: s.taxId, address: s.address, taxName: s.taxName, taxRate: s.taxRate?.toFixed(2) ?? null, pricesIncludeTax: s.pricesIncludeTax, quoteValidityDays: s.quoteValidityDays, quoteTerms: s.quoteTerms, contactEmail: s.contactEmail };
  }

  async updateSettings(userId: string, input: z.infer<typeof quoteSettingsSchema>) {
    await this.db.system.commercialSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    await this.db.system.commercialSettings.update({
      where: { id: 1 },
      data: { legalName: input.legalName ?? null, taxId: input.taxId ?? null, address: input.address ?? null, taxName: input.taxName ?? null, taxRate: input.taxRate || null, pricesIncludeTax: input.pricesIncludeTax, quoteValidityDays: input.quoteValidityDays, quoteTerms: input.quoteTerms ?? null, updatedById: userId },
    });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.quote_settings_updated', entityType: 'commercial_settings', metadata: { taxName: input.taxName ?? null, taxRate: input.taxRate ?? null, pricesIncludeTax: input.pricesIncludeTax } });
    return this.settings();
  }

  // ---- Cotizaciones (equipo) ----

  async list(f: { status?: string; leadId?: string }) {
    await this.expireOverdue();
    return this.db.system.salesQuote.findMany({
      where: { ...(f.status ? { status: f.status as never } : {}), ...(f.leadId ? { leadId: f.leadId } : {}) },
      orderBy: { number: 'desc' },
      take: 200,
      select: {
        id: true, number: true, status: true, currency: true, totalOneTime: true, totalMonthly: true, validUntil: true, sentAt: true, acceptedAt: true, createdAt: true,
        lead: { select: { id: true, number: true, name: true, company: true } },
        paymentOrders: { where: { status: { not: 'CANCELLED' } }, select: { id: true, number: true, status: true } },
      },
    });
  }

  async get(id: string) {
    await this.expireOverdue();
    const q = await this.db.system.salesQuote.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { position: 'asc' } },
        lead: { select: { id: true, number: true, name: true, company: true, email: true, phone: true, status: true } },
        contractVersion: { select: { id: true, version: true, title: true } },
        paymentOrders: { orderBy: { number: 'desc' }, select: { id: true, number: true, status: true, amount: true, currency: true, createdAt: true } },
      },
    });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    const { accessTokenHash: _h, ...rest } = q;
    return { ...rest, initialAmount: this.initialAmount(q) };
  }

  async create(userId: string, input: QuoteInput & { leadId: string }) {
    const lead = await this.db.system.salesLead.findUnique({ where: { id: input.leadId }, select: { id: true, status: true } });
    if (!lead) throw new NotFoundException('Prospecto no encontrado');
    if (lead.status === 'LOST') throw new ConflictException({ code: 'LEAD_LOST', message: 'El prospecto está marcado como perdido' });
    const data = await this.draftData(input);
    const q = await this.db.system.$transaction(async (tx) => {
      const q = await tx.salesQuote.create({ data: { ...data.quote, leadId: input.leadId, createdById: userId, lines: { create: data.lines } }, select: { id: true, number: true } });
      await logSalesActivity(tx, input.leadId, userId, 'NOTE', `Cotización ${quoteNo(q.number)} creada (borrador)`, { quoteId: q.id });
      return q;
    });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.quote_created', entityType: 'sales_quote', entityId: q.id, metadata: { number: q.number, leadId: input.leadId } });
    return this.get(q.id);
  }

  async update(userId: string, id: string, input: QuoteInput) {
    const q = await this.db.system.salesQuote.findUnique({ where: { id }, select: { status: true } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    if (q.status !== 'DRAFT') throw new ConflictException({ code: 'QUOTE_FROZEN', message: 'Una cotización enviada no se modifica: crea una nueva' });
    const data = await this.draftData(input);
    await this.db.system.$transaction(async (tx) => {
      await tx.salesQuoteLine.deleteMany({ where: { quoteId: id } });
      await tx.salesQuote.update({ where: { id }, data: { ...data.quote, lines: { create: data.lines } } });
    });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.quote_updated', entityType: 'sales_quote', entityId: id });
    return this.get(id);
  }

  async remove(userId: string, id: string) {
    const q = await this.db.system.salesQuote.findUnique({ where: { id }, select: { status: true, number: true, leadId: true } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    if (q.status !== 'DRAFT') throw new ConflictException({ code: 'QUOTE_FROZEN', message: 'Una cotización enviada no se borra: anúlala' });
    await this.db.system.$transaction(async (tx) => {
      await tx.salesQuote.delete({ where: { id } });
      await logSalesActivity(tx, q.leadId, userId, 'NOTE', `Borrador ${quoteNo(q.number)} eliminado`, {});
    });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.quote_deleted', entityType: 'sales_quote', entityId: id, metadata: { number: q.number } });
  }

  /** Envía: congela el contenido, fija vigencia, contrato y emisor, y devuelve el enlace del cliente (una sola vez) */
  async send(userId: string, id: string) {
    const q = await this.db.system.salesQuote.findUnique({ where: { id }, include: { lead: true, lines: true } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    if (q.status !== 'DRAFT') throw new ConflictException({ code: 'QUOTE_NOT_DRAFT', message: 'Esta cotización ya fue enviada' });
    if (q.lead.status === 'LOST') throw new ConflictException({ code: 'LEAD_LOST', message: 'El prospecto está marcado como perdido' });
    const contract = await this.db.system.contractVersion.findFirst({ orderBy: { version: 'desc' } });
    if (!contract) throw new ConflictException({ code: 'NO_CONTRACT', message: 'Primero registra el texto del contrato (Cotizaciones y pagos › Configuración)' });
    const s = await this.db.system.commercialSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const terms = q.terms ?? s.quoteTerms;
    if (!terms) throw new ConflictException({ code: 'NO_TERMS', message: 'Escribe las condiciones en la cotización o las condiciones generales en la configuración' });
    if (!s.legalName) throw new ConflictException({ code: 'NO_ISSUER', message: 'Completa la razón social del emisor en la configuración' });
    if (cents(this.initialAmount(q)) <= 0) throw new ConflictException({ code: 'ZERO_INITIAL_PAYMENT', message: 'El pago inicial es 0: revisa los conceptos o el tipo de pago inicial' });
    const today = todayLima();
    const validUntil = q.validUntil ? q.validUntil.toISOString().slice(0, 10) : addDays(today, s.quoteValidityDays);
    if (validUntil < today) throw new BadRequestException({ code: 'VALIDITY_PAST', message: 'La vigencia ya pasó' });
    const { token, hash } = newAccessToken();
    await this.db.system.$transaction(async (tx) => {
      const r = await tx.salesQuote.updateMany({
        where: { id, status: 'DRAFT' },
        data: {
          status: 'SENT', sentAt: new Date(), sentById: userId, accessTokenHash: hash, contractVersionId: contract.id, terms, validUntil: new Date(`${validUntil}T00:00:00Z`),
          issuer: { legalName: s.legalName, taxId: s.taxId, address: s.address, email: s.contactEmail, whatsapp: s.contactWhatsapp },
          client: { name: q.lead.name, company: q.lead.company, email: q.lead.email, phone: q.lead.phone, country: q.country },
        },
      });
      if (r.count !== 1) throw new ConflictException({ code: 'QUOTE_NOT_DRAFT', message: 'Esta cotización ya fue enviada' });
      await logSalesActivity(tx, q.leadId, userId, 'NOTE', `Cotización ${quoteNo(q.number)} enviada: ${q.currency} ${q.totalOneTime.toFixed(2)} único y ${q.currency} ${q.totalMonthly.toFixed(2)} mensual, vigente hasta ${validUntil}`, { quoteId: id, contractVersion: contract.version });
      await advanceLead(tx, q.leadId, 'QUOTE_SENT', EARLY_TO_QUOTE, 'quote_sent', userId);
    });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.quote_sent', entityType: 'sales_quote', entityId: id, metadata: { number: q.number, contractVersion: contract.version, validUntil } });
    const path = `/propuesta/${id}?t=${token}`;
    const emailed = q.lead.email ? await this.mail.send({ to: q.lead.email, subject: `Propuesta ${quoteNo(q.number)} de ${s.legalName}`, text: `Hola ${q.lead.name}:\n\nTe enviamos la propuesta ${quoteNo(q.number)}, vigente hasta el ${validUntil}. Puedes verla, descargarla en PDF y aceptarla aquí:\n\n${this.webUrl()}${path}\n\nSi tienes dudas, responde a este correo.` }).catch(() => false) : false;
    return { path, emailed };
  }

  /** Nuevo enlace para el cliente (el anterior deja de servir) */
  async relink(userId: string, id: string) {
    const q = await this.db.system.salesQuote.findUnique({ where: { id }, select: { status: true } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    if (q.status !== 'SENT' && q.status !== 'ACCEPTED') throw new ConflictException({ code: 'QUOTE_NOT_SENT', message: 'Solo una cotización enviada o aceptada tiene enlace' });
    const { token, hash } = newAccessToken();
    await this.db.system.salesQuote.update({ where: { id }, data: { accessTokenHash: hash } });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.quote_relinked', entityType: 'sales_quote', entityId: id });
    return { path: `/propuesta/${id}?t=${token}` };
  }

  async cancel(userId: string, id: string, reason: string | null) {
    const q = await this.db.system.salesQuote.findUnique({ where: { id }, select: { status: true, number: true, leadId: true } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    if (q.status !== 'SENT') throw new ConflictException({ code: 'QUOTE_NOT_SENT', message: q.status === 'DRAFT' ? 'Un borrador se elimina, no se anula' : 'La cotización ya está cerrada' });
    await this.db.system.$transaction(async (tx) => {
      await tx.salesQuote.update({ where: { id }, data: { status: 'CANCELLED', closedAt: new Date(), rejectionReason: reason } });
      await logSalesActivity(tx, q.leadId, userId, 'NOTE', `Cotización ${quoteNo(q.number)} anulada${reason ? `: ${reason}` : ''}`, { quoteId: id });
    });
    await this.audit.system({ tenantId: null, userId, action: 'commercial.quote_cancelled', entityType: 'sales_quote', entityId: id, metadata: { reason } });
    return this.get(id);
  }

  async pdf(id: string) {
    const q = await this.db.system.salesQuote.findUnique({ where: { id }, include: { lines: { orderBy: { position: 'asc' } }, lead: true, contractVersion: true } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    return { name: `${quoteNo(q.number)}.pdf`, buffer: await renderQuotePdf(await this.pdfData(q)) };
  }

  // ---- Cliente (enlace) ----

  async publicView(id: string, token: string) {
    const q = await this.authorized(id, token);
    return {
      number: q.number, code: quoteNo(q.number), status: q.status, currency: q.currency, sentAt: q.sentAt, validUntil: q.validUntil?.toISOString().slice(0, 10) ?? null,
      issuer: q.issuer, client: q.client, planName: q.planCode ? (PLAN_NAME[q.planCode] ?? q.planCode) : null, users: q.users, modules: moduleNames(q.modules), deploymentMode: q.deploymentMode,
      serverResources: q.serverResources, initialSetup: q.initialSetup, integrations: q.integrations, support: q.support, maintenance: q.maintenance, notes: q.notes,
      lines: q.lines.map((l) => ({ description: l.description, billing: l.billing, quantity: l.quantity.toFixed(2), unitPrice: l.unitPrice.toFixed(2), total: l.total.toFixed(2) })),
      taxName: q.taxName, taxRate: q.taxRate?.toFixed(2) ?? null, pricesIncludeTax: q.pricesIncludeTax,
      subtotalOneTime: q.subtotalOneTime.toFixed(2), taxOneTime: q.taxOneTime.toFixed(2), totalOneTime: q.totalOneTime.toFixed(2),
      subtotalMonthly: q.subtotalMonthly.toFixed(2), taxMonthly: q.taxMonthly.toFixed(2), totalMonthly: q.totalMonthly.toFixed(2),
      initialPayment: q.initialPayment, initialAmount: this.initialAmount(q), terms: q.terms,
      contract: q.contractVersion ? { version: q.contractVersion.version, title: q.contractVersion.title, body: q.contractVersion.body } : null,
      accepted: q.acceptedAt ? { at: q.acceptedAt, name: q.acceptedName } : null,
    };
  }

  async publicPdf(id: string, token: string) {
    await this.authorized(id, token);
    return this.pdf(id);
  }

  async accept(id: string, token: string, input: z.infer<typeof acceptSchema>, meta: { ip: string | null; userAgent: string | null }) {
    const q = await this.authorized(id, token);
    if (q.status === 'EXPIRED') throw new ConflictException({ code: 'QUOTE_EXPIRED', message: 'La propuesta venció. Pide una nueva a tu asesor.' });
    if (q.status !== 'SENT') throw new ConflictException({ code: 'QUOTE_CLOSED', message: q.status === 'ACCEPTED' ? 'Esta propuesta ya fue aceptada' : 'Esta propuesta ya no está disponible' });
    if (input.contractVersion !== q.contractVersion?.version) throw new ConflictException({ code: 'CONTRACT_CHANGED', message: 'El contrato mostrado no es el de esta propuesta: recarga la página' });
    const lead = await this.db.system.salesLead.findUniqueOrThrow({ where: { id: q.leadId }, select: { status: true } });
    if (lead.status === 'LOST') throw new ConflictException({ code: 'QUOTE_CLOSED', message: 'Esta propuesta ya no está disponible. Escríbenos para retomarla.' });
    const order = await this.db.system.$transaction(async (tx) => {
      const r = await tx.salesQuote.updateMany({
        where: { id, status: 'SENT' },
        data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedName: input.name, acceptedDocument: input.document ?? null, acceptedEmail: input.email, acceptedIp: meta.ip?.slice(0, 64) ?? null, acceptedUserAgent: meta.userAgent?.slice(0, 300) ?? null, closedAt: new Date() },
      });
      if (r.count !== 1) throw new ConflictException({ code: 'QUOTE_CLOSED', message: 'Esta propuesta ya no está disponible' });
      await logSalesActivity(tx, q.leadId, null, 'NOTE', `Propuesta ${quoteNo(q.number)} aceptada por ${input.name}${input.document ? ` (${input.document})` : ''} con el contrato versión ${q.contractVersion!.version}`, { quoteId: id, ip: meta.ip, by: 'client' });
      const o = await this.payments.createForQuote(tx, { id, number: q.number, leadId: q.leadId, currency: q.currency, country: q.country, amount: this.initialAmount(q), initialPayment: q.initialPayment }, null);
      await advanceLead(tx, q.leadId, 'PAYMENT_PENDING', ['NEW', 'CONTACTED', 'QUALIFIED', 'DEMO_REQUESTED', 'QUOTE_SENT', 'NEGOTIATION'], 'quote_accepted', null);
      return o;
    });
    await this.audit.system({ tenantId: null, action: 'commercial.quote_accepted', entityType: 'sales_quote', entityId: id, metadata: { number: q.number, name: input.name, contractVersion: q.contractVersion!.version, ip: meta.ip, paymentOrder: order.number } });
    const to = input.email ?? (q.client as { email?: string } | null)?.email;
    if (to) await this.mail.send({ to, subject: `Orden de pago de la propuesta ${quoteNo(q.number)}`, text: `Gracias por aceptar la propuesta ${quoteNo(q.number)}.\n\nPara activar el servicio, realiza el pago de ${q.currency} ${this.initialAmount(q)} con los datos de este enlace e informa la operación:\n\n${this.webUrl()}${order.path}\n\nLa instalación empieza cuando validemos el pago en nuestra cuenta.` }).catch(() => false);
    return { paymentPath: order.path };
  }

  async reject(id: string, token: string, reason: string | null) {
    const q = await this.authorized(id, token);
    if (q.status !== 'SENT') throw new ConflictException({ code: 'QUOTE_CLOSED', message: 'Esta propuesta ya no está disponible' });
    await this.db.system.$transaction(async (tx) => {
      const r = await tx.salesQuote.updateMany({ where: { id, status: 'SENT' }, data: { status: 'REJECTED', rejectedAt: new Date(), rejectionReason: reason, closedAt: new Date() } });
      if (r.count !== 1) throw new ConflictException({ code: 'QUOTE_CLOSED', message: 'Esta propuesta ya no está disponible' });
      await logSalesActivity(tx, q.leadId, null, 'NOTE', `El cliente rechazó la propuesta ${quoteNo(q.number)}${reason ? `: ${reason}` : ''}`, { quoteId: id, by: 'client' });
      await tx.salesLead.update({ where: { id: q.leadId }, data: { nextAction: `Contactar: rechazó la propuesta ${quoteNo(q.number)}`, nextActionAt: new Date() } });
    });
    return { ok: true };
  }

  // ---- Internos ----

  private async authorized(id: string, token: string) {
    await this.expireOverdue();
    const q = await this.db.system.salesQuote.findUnique({ where: { id }, include: { lines: { orderBy: { position: 'asc' } }, contractVersion: true } });
    const ok = q?.accessTokenHash && token.length >= 20 && timingSafeEqual(Buffer.from(q.accessTokenHash, 'hex'), Buffer.from(sha256(token), 'hex'));
    if (!q || !ok || q.status === 'DRAFT') throw new NotFoundException({ code: 'QUOTE_LINK', message: 'El enlace no es válido o fue reemplazado. Pide uno nuevo a tu asesor.' });
    return q;
  }

  /** Vencidas: enviadas cuya vigencia pasó (se marca al consultar; no hace falta un proceso aparte) */
  private async expireOverdue() {
    const today = new Date(`${todayLima()}T00:00:00Z`);
    await this.db.system.salesQuote.updateMany({ where: { status: 'SENT', validUntil: { lt: today } }, data: { status: 'EXPIRED', closedAt: new Date() } });
  }

  private initialAmount(q: { initialPayment: string; totalOneTime: { toString(): string }; totalMonthly: { toString(): string } }) {
    return fromCents(cents(q.totalOneTime) + (q.initialPayment === 'ONE_TIME_AND_FIRST_MONTH' ? cents(q.totalMonthly) : 0));
  }

  private async draftData(input: QuoteInput) {
    const ids = input.lines.map((l) => l.itemId).filter((x): x is string => !!x);
    const items = ids.length ? await this.db.system.commercialItem.findMany({ where: { id: { in: ids } } }) : [];
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const l of input.lines) {
      if (!l.itemId) continue;
      const it = byId.get(l.itemId);
      if (!it) throw new BadRequestException({ code: 'UNKNOWN_ITEM', message: 'Un concepto del catálogo no existe' });
      if (!it.isActive) throw new BadRequestException({ code: 'INACTIVE_ITEM', message: `«${it.name}» está desactivado en el catálogo` });
      if (it.currency !== input.currency) throw new BadRequestException({ code: 'CURRENCY_MISMATCH', message: `«${it.name}» tiene precio en ${it.currency} y la cotización es en ${input.currency}` });
    }
    const s = await this.db.system.commercialSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const tax = { name: s.taxName, rate: s.taxRate?.toString() ?? null, included: s.pricesIncludeTax };
    const t = quoteTotals(input.lines, tax);
    const quote = {
      currency: input.currency, country: input.country ?? null, planCode: input.planCode ?? null, users: input.users ?? null, modules: input.modules,
      deploymentMode: input.deploymentMode ?? null, serverResources: input.serverResources ?? null, initialSetup: input.initialSetup ?? null, integrations: input.integrations ?? null,
      support: input.support ?? null, maintenance: input.maintenance ?? null, notes: input.notes ?? null, initialPayment: input.initialPayment,
      validUntil: input.validUntil ? new Date(`${input.validUntil}T00:00:00Z`) : null, terms: input.terms ?? null,
      taxName: s.taxName, taxRate: s.taxRate, pricesIncludeTax: s.pricesIncludeTax,
      subtotalOneTime: fromCents(t.subtotalOneTime), subtotalMonthly: fromCents(t.subtotalMonthly), taxOneTime: fromCents(t.taxOneTime), taxMonthly: fromCents(t.taxMonthly),
      totalOneTime: fromCents(t.totalOneTime), totalMonthly: fromCents(t.totalMonthly),
    } satisfies Partial<Prisma.SalesQuoteUncheckedCreateInput>;
    const lines = input.lines.map((l, i) => ({ position: i + 1, itemId: l.itemId ?? null, kind: l.kind, billing: l.billing, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, total: fromCents(lineTotal(l.quantity, l.unitPrice)) }));
    return { quote, lines };
  }

  private async pdfData(q: Prisma.SalesQuoteGetPayload<{ include: { lines: true; lead: true; contractVersion: true } }>): Promise<QuotePdfData> {
    const s = q.issuer ? null : await this.db.system.commercialSettings.findUnique({ where: { id: 1 } });
    const issuer = (q.issuer as QuotePdfData['issuer'] | null) ?? { legalName: s?.legalName ?? null, taxId: s?.taxId ?? null, address: s?.address ?? null, email: s?.contactEmail ?? null, whatsapp: s?.contactWhatsapp ?? null };
    const client = (q.client as QuotePdfData['client'] | null) ?? { name: q.lead.name, company: q.lead.company, email: q.lead.email, phone: q.lead.phone, country: q.country };
    return {
      number: q.number, status: q.status, currency: q.currency, sentAt: q.sentAt, validUntil: q.validUntil, issuer, client,
      planName: q.planCode ? (PLAN_NAME[q.planCode] ?? q.planCode) : null, users: q.users, modules: moduleNames(q.modules), deploymentMode: q.deploymentMode,
      serverResources: q.serverResources, initialSetup: q.initialSetup, integrations: q.integrations, support: q.support, maintenance: q.maintenance, notes: q.notes,
      lines: q.lines.map((l) => ({ description: l.description, billing: l.billing, quantity: l.quantity.toFixed(2), unitPrice: l.unitPrice.toFixed(2), total: l.total.toFixed(2) })),
      taxName: q.taxName, taxRate: q.taxRate?.toFixed(2) ?? null, pricesIncludeTax: q.pricesIncludeTax,
      subtotalOneTime: q.subtotalOneTime.toFixed(2), taxOneTime: q.taxOneTime.toFixed(2), totalOneTime: q.totalOneTime.toFixed(2),
      subtotalMonthly: q.subtotalMonthly.toFixed(2), taxMonthly: q.taxMonthly.toFixed(2), totalMonthly: q.totalMonthly.toFixed(2),
      initialPayment: q.initialPayment, initialAmount: this.initialAmount(q), terms: q.terms,
      contract: q.contractVersion ? { version: q.contractVersion.version, title: q.contractVersion.title } : null,
      accepted: q.acceptedAt ? { at: q.acceptedAt, name: q.acceptedName ?? '', document: q.acceptedDocument } : null,
    };
  }

  private webUrl() {
    return this.env.APP_PUBLIC_URL.replace(/\/$/, '');
  }
}

function addDays(isoDate: string, days: number) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
