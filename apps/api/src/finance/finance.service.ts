import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { MailService } from '../mail/mail.service.js';
import { subscriptionAccess } from '../plans/subscription-access.js';
import { orderNo, quoteNo } from '../quotes/quote-pdf.js';
import {
  CATEGORIES, CATEGORY_LABEL, type CostCategory, type CostLine, type Money, budgetLevel, convert, currentPeriod, manualFor, margin, missingRates, periodRange, serverCost, sum,
} from './profitability.js';

const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Moneda de 3 letras (PEN, USD, EUR)');
const amount = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((v) => /^\d{1,9}(\.\d{1,2})?$/.test(v), 'Importe inválido (hasta 2 decimales)');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

export const periodSchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Periodo AAAA-MM').optional() });
export const costItemSchema = z.object({
  category: z.enum(CATEGORIES as [CostCategory, ...CostCategory[]]),
  description: z.string().trim().min(2).max(200),
  amount,
  currency,
  cycle: z.enum(['MONTHLY', 'ONE_TIME']),
  startsOn: day,
  endsOn: day.nullable().optional(),
}).refine((v) => !v.endsOn || v.endsOn >= v.startsOn, { message: 'El fin no puede ser anterior al inicio', path: ['endsOn'] });
export const endCostSchema = z.object({ endsOn: day });
export const budgetSchema = z.object({ amount: amount.refine((v) => Number(v) > 0, 'Debe ser mayor que 0'), currency, thresholdPct: z.number().int().min(1).max(100).default(80) });
export const settingsSchema = z.object({
  baseCurrency: currency,
  rates: z.record(currency, z.number().positive().max(100_000)).refine((r) => Object.keys(r).length <= 20, 'Demasiadas monedas'),
});

type Scope = 'AI' | 'TOTAL';
const BILLABLE_AI = ['MANAGED', 'SERVER'];
const n = (v: { toString(): string } | null | undefined) => (v == null ? null : Number(v.toString()));

/**
 * Rentabilidad por instalación (ADR 055). Ingreso recurrente pactado contra los
 * costos medidos (servidor por horas, IA por llamada) y los registrados a mano
 * (WhatsApp, almacenamiento, servicios externos, soporte). Solo la plataforma.
 */
@Injectable()
export class FinanceService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  async settings() {
    const s = await this.db.system.financeSettings.findUnique({ where: { id: 1 } });
    return { baseCurrency: s?.baseCurrency ?? 'PEN', rates: (s?.rates ?? {}) as Record<string, number>, updatedAt: s?.updatedAt ?? null };
  }

  async saveSettings(userId: string, input: z.infer<typeof settingsSchema>) {
    const rates = Object.fromEntries(Object.entries(input.rates).filter(([k]) => k !== input.baseCurrency));
    await this.db.system.financeSettings.upsert({ where: { id: 1 }, create: { id: 1, baseCurrency: input.baseCurrency, rates, updatedById: userId }, update: { baseCurrency: input.baseCurrency, rates, updatedById: userId, updatedAt: new Date() } });
    await this.audit.system({ tenantId: null, userId, action: 'finance.settings', entityType: 'finance_settings', entityId: '1', metadata: { baseCurrency: input.baseCurrency, rates } });
    return this.settings();
  }

  /** Cálculo de una empresa en un mes */
  async tenantReport(tenantId: string, period = currentPeriod(), now = new Date()) {
    const range = periodRange(period);
    const { baseCurrency: base, rates } = await this.settings();
    const sys = this.db.system;
    const tenant = await sys.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, status: true, deploymentMode: true, subscription: { select: { status: true, trialEndsAt: true, currentPeriodEnd: true, plan: { select: { name: true, priceMonthly: true, currency: true } } } } },
    });
    if (!tenant) throw new NotFoundException('Empresa no encontrada');
    const [lead, payments, servers, ai, items, budgets, outbound, tickets, images] = await Promise.all([
      sys.salesLead.findUnique({
        where: { tenantId },
        select: {
          id: true, name: true,
          quotes: { where: { status: 'ACCEPTED' }, orderBy: { acceptedAt: 'desc' }, take: 1, select: { id: true, number: true, currency: true, subtotalMonthly: true, subtotalOneTime: true, acceptedAt: true } },
          paymentOrders: { where: { status: { in: ['PENDING', 'PROOF_SUBMITTED'] } }, select: { id: true, number: true, concept: true, amount: true, currency: true, status: true, createdAt: true } },
          accounting: { where: { entryDate: { gte: range.start, lt: range.end } }, select: { net: true, currency: true } },
        },
      }),
      sys.payment.findMany({ where: { tenantId }, orderBy: { paidAt: 'desc' }, select: { amount: true, currency: true, months: true, paidAt: true, periodStart: true, periodEnd: true } }),
      sys.infraServer.findMany({ where: { tenantId }, select: { id: true, name: true, status: true, serverType: true, priceHourly: true, priceMonthly: true, currency: true, providerCreatedAt: true, deletedAt: true } }),
      sys.aiUsageEvent.groupBy({ by: ['mode', 'costCurrency'], where: { tenantId, createdAt: { gte: range.start, lt: range.end } }, _sum: { cost: true, inputTokens: true, outputTokens: true }, _count: { _all: true, cost: true } }),
      sys.tenantCostItem.findMany({ where: { tenantId }, orderBy: [{ category: 'asc' }, { startsOn: 'asc' }], select: { id: true, category: true, description: true, amount: true, currency: true, cycle: true, startsOn: true, endsOn: true, createdAt: true } }),
      sys.tenantBudget.findMany({ where: { tenantId }, select: { scope: true, amount: true, currency: true, thresholdPct: true } }),
      sys.message.count({ where: { tenantId, direction: 'OUTBOUND', createdAt: { gte: range.start, lt: range.end } } }),
      sys.supportTicket.count({ where: { tenantId, createdAt: { gte: range.start, lt: range.end } } }),
      sys.productImage.count({ where: { tenantId } }),
    ]);

    // ------------------------------------------------ Precio de venta e ingreso recurrente
    const quote = lead?.quotes[0] ?? null;
    const sub = tenant.subscription;
    const access = sub ? subscriptionAccess(sub, this.env.BILLING_GRACE_DAYS, now) : null;
    const lastPayment = payments[0] ?? null;
    const paidMonthly = lastPayment ? { amount: Number(lastPayment.amount) / lastPayment.months, currency: lastPayment.currency } : null;
    let mrr: (Money & { source: 'quote' | 'payment' }) | null = null;
    let mrrNote: string;
    if (quote && Number(quote.subtotalMonthly) > 0) {
      mrr = { amount: Number(quote.subtotalMonthly), currency: quote.currency, source: 'quote' };
      mrrNote = `Cotización ${quoteNo(quote.number)} aceptada (sin impuestos)`;
    } else if (paidMonthly && access && !access.readOnly && access.state !== 'TRIAL') {
      mrr = { ...paidMonthly, amount: Math.round(paidMonthly.amount * 100) / 100, source: 'payment' };
      mrrNote = 'Último pago del plan, por mes';
    } else {
      mrrNote = access?.state === 'TRIAL' ? 'En prueba: aún no paga' : access?.readOnly ? 'Plan vencido o cancelado' : 'Sin cotización aceptada ni pagos del plan';
    }
    const collected = sum([
      ...payments.filter((p) => p.periodStart < range.end && p.periodEnd > range.start).map((p) => ({ amount: Number(p.amount) / p.months, currency: p.currency })),
      ...(lead?.accounting ?? []).map((a) => ({ amount: Number(a.net), currency: a.currency })),
    ]);

    // ------------------------------------------------ Costos
    const manual = manualFor(items.map((i) => ({ ...i, amount: Number(i.amount) })), range);
    const manualOf = (c: CostCategory) => manual.filter((i) => i.category === c).map((i) => ({ amount: i.amount, currency: i.currency }));
    const lines: CostLine[] = [];
    // Servidor: medido por horas con el precio del proveedor
    const serverCosts = servers.map((s) => ({ s, cost: serverCost({ ...s, priceHourly: n(s.priceHourly), priceMonthly: n(s.priceMonthly) }, range, now) }));
    const unpriced = serverCosts.filter((x) => !x.cost);
    const serverManual = manualOf('SERVER');
    lines.push({
      category: 'SERVER',
      measured: sum(serverCosts.flatMap((x) => (x.cost ? [x.cost] : []))),
      manual: sum(serverManual),
      known: unpriced.length ? false : servers.length > 0 || serverManual.length > 0,
      note: unpriced.length ? `${unpriced.length} servidor(es) sin precio del proveedor`
        : servers.length ? `${servers.length} servidor(es) del gestor de infraestructura, por horas encendido`
          : tenant.deploymentMode === 'SAAS' ? 'usa el servidor compartido: registra la parte que le corresponde' : 'no hay servidor registrado en Infraestructura',
    });
    // IA: costo por llamada con las claves de la plataforma; con la clave propia del cliente lo paga él
    const billable = ai.filter((g) => BILLABLE_AI.includes(g.mode));
    const unpricedCalls = billable.reduce((a, g) => a + (g._count._all - g._count.cost), 0);
    const ownCalls = ai.filter((g) => g.mode === 'OWN').reduce((a, g) => a + g._count._all, 0);
    lines.push({
      category: 'AI',
      measured: sum(billable.filter((g) => g._sum.cost != null && g.costCurrency).map((g) => ({ amount: Number(g._sum.cost), currency: g.costCurrency! }))),
      manual: sum(manualOf('AI')),
      known: unpricedCalls === 0,
      note: unpricedCalls ? `${unpricedCalls} llamada(s) con un modelo sin precio configurado (Centro de APIs)` : `${billable.reduce((a, g) => a + g._count._all, 0)} llamada(s) con claves de la plataforma${ownCalls ? `; ${ownCalls} con la clave propia del cliente (las paga él)` : ''}`,
    });
    const manualLine = (c: CostCategory, info: string) => {
      const m = manualOf(c);
      lines.push({ category: c, measured: [], manual: sum(m), known: m.length > 0, note: m.length ? info : `sin registrar (${info})` });
    };
    manualLine('WHATSAPP', `${outbound} mensaje(s) enviados en el mes; la tarifa de Meta depende de la cuenta`);
    manualLine('STORAGE', `${images} imagen(es) de productos`);
    manualLine('EXTERNAL', 'dominio, correo y otros servicios');
    manualLine('SUPPORT', `${tickets} caso(s) de soporte abiertos en el mes`);

    // ------------------------------------------------ Pagos pendientes
    const pending = [
      ...(lead?.paymentOrders ?? []).map((o) => ({ kind: 'order' as const, id: o.id, label: `Orden de pago ${orderNo(o.number)}: ${o.concept}`, amount: Number(o.amount), currency: o.currency, status: o.status, since: o.createdAt })),
      ...(access && (access.state === 'GRACE' || access.state === 'EXPIRED') && sub?.status !== 'CANCELED'
        ? [{ kind: 'renewal' as const, id: tenantId, label: `Renovación del plan ${sub!.plan.name} (venció el ${access.endsAt.slice(0, 10)})`, amount: Math.round((paidMonthly?.amount ?? Number(sub!.plan.priceMonthly)) * 100) / 100, currency: paidMonthly?.currency ?? sub!.plan.currency, status: access.state, since: new Date(access.endsAt) }]
        : []),
    ];

    // ------------------------------------------------ Presupuestos
    const aiSpend = [...lines[1]!.measured, ...lines[1]!.manual];
    const allSpend = lines.flatMap((l) => [...l.measured, ...l.manual]);
    const budgetView = budgets.map((b) => {
      const spentItems = b.scope === 'AI' ? aiSpend : allSpend;
      const to = this.ratesTo(b.currency, base, rates);
      const spent = convert(spentItems, b.currency, to);
      const amt = Number(b.amount);
      return {
        scope: b.scope as Scope, amount: amt, currency: b.currency, thresholdPct: b.thresholdPct, spent,
        level: spent == null ? null : budgetLevel(spent, amt, b.thresholdPct),
        missingRates: spent == null ? missingRates(spentItems, b.currency, to) : [],
      };
    });

    return {
      period, partial: now < range.end, base, rates,
      tenant: { id: tenant.id, name: tenant.name, status: tenant.status, deploymentMode: tenant.deploymentMode },
      lead: lead ? { id: lead.id, name: lead.name } : null,
      price: {
        monthly: quote ? { amount: Number(quote.subtotalMonthly), currency: quote.currency } : null,
        oneTime: quote ? { amount: Number(quote.subtotalOneTime), currency: quote.currency } : null,
        quoteId: quote?.id ?? null,
        plan: sub ? { name: sub.plan.name, listPrice: { amount: Number(sub.plan.priceMonthly), currency: sub.plan.currency } } : null,
        access: access?.state ?? null,
      },
      mrr: mrr ? { amount: mrr.amount, currency: mrr.currency, source: mrr.source } : null,
      mrrNote,
      collected,
      costs: lines.map((l) => ({ ...l, label: CATEGORY_LABEL[l.category] })),
      margin: margin({ base, rates, mrr, costs: lines }),
      pending,
      budgets: budgetView,
      items: items.map((i) => ({ ...i, amount: Number(i.amount).toFixed(2), startsOn: i.startsOn.toISOString().slice(0, 10), endsOn: i.endsOn?.toISOString().slice(0, 10) ?? null, inPeriod: manual.some((m) => m.id === i.id) })),
      servers: serverCosts.map(({ s, cost }) => ({ id: s.id, name: s.name, status: s.status, serverType: s.serverType, deleted: !!s.deletedAt, priceMonthly: n(s.priceMonthly), currency: s.currency, cost })),
    };
  }

  /** Tipos expresados en otra moneda de destino (para comparar con un presupuesto en USD, por ejemplo) */
  private ratesTo(target: string, base: string, rates: Record<string, number>): Record<string, number> {
    const toBase = (c: string) => (c === base ? 1 : rates[c]);
    const t = toBase(target);
    if (!t) return {};
    const out: Record<string, number> = {};
    for (const c of new Set([base, ...Object.keys(rates)])) {
      const v = toBase(c);
      if (c !== target && v) out[c] = v / t;
    }
    return out;
  }

  /** Resumen de todas las empresas del mes */
  async overview(period = currentPeriod(), now = new Date()) {
    const tenants = await this.db.system.tenant.findMany({ orderBy: { name: 'asc' }, take: 500, select: { id: true } });
    const rows = [];
    for (const t of tenants) rows.push(await this.tenantReport(t.id, period, now));
    const { baseCurrency: base, rates } = await this.settings();
    const mrrItems = rows.flatMap((r) => (r.mrr ? [r.mrr] : []));
    const pendingItems = rows.flatMap((r) => r.pending.map((p) => ({ amount: p.amount, currency: p.currency })));
    const withMargin = rows.filter((r) => r.margin.value != null);
    return {
      period, base, rates,
      totals: {
        mrr: { byCurrency: sum(mrrItems), base: convert(mrrItems, base, rates) },
        pending: { byCurrency: sum(pendingItems), base: convert(pendingItems, base, rates), count: pendingItems.length },
        margin: { known: withMargin.length, unknown: rows.length - withMargin.length, value: withMargin.length ? Math.round(withMargin.reduce((a, r) => a + r.margin.value!, 0) * 100) / 100 : null, negative: withMargin.filter((r) => r.margin.value! < 0).length },
        alerts: rows.reduce((a, r) => a + r.budgets.filter((b) => b.level).length, 0),
      },
      rows: rows.map((r) => ({
        tenant: r.tenant, mrr: r.mrr, mrrNote: r.mrrNote, collected: r.collected,
        costs: r.costs.map((c) => ({ category: c.category, label: c.label, known: c.known, total: sum([...c.measured, ...c.manual]) })),
        margin: r.margin, pending: r.pending.length, budgets: r.budgets.map((b) => ({ scope: b.scope, level: b.level })),
      })),
    };
  }

  // ------------------------------------------------ Partidas y presupuestos

  private async requireTenant(tenantId: string) {
    if (!(await this.db.system.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) throw new NotFoundException('Empresa no encontrada');
  }

  async addCost(userId: string, tenantId: string, input: z.infer<typeof costItemSchema>) {
    await this.requireTenant(tenantId);
    const item = await this.db.system.tenantCostItem.create({
      data: { tenantId, category: input.category, description: input.description, amount: input.amount, currency: input.currency, cycle: input.cycle, startsOn: new Date(input.startsOn), endsOn: input.endsOn ? new Date(input.endsOn) : null, createdById: userId },
    });
    await this.audit.system({ tenantId, userId, action: 'finance.cost_added', entityType: 'tenant_cost_item', entityId: item.id, metadata: { category: input.category, amount: input.amount, currency: input.currency, cycle: input.cycle } });
    return item;
  }

  /** Las partidas no se borran: se terminan (el historial de meses anteriores no cambia) */
  async endCost(userId: string, tenantId: string, id: string, input: z.infer<typeof endCostSchema>) {
    const item = await this.db.system.tenantCostItem.findFirst({ where: { id, tenantId } });
    if (!item) throw new NotFoundException('Partida no encontrada');
    const endsOn = new Date(input.endsOn);
    if (endsOn < item.startsOn) throw new NotFoundException('El fin no puede ser anterior al inicio');
    await this.db.system.tenantCostItem.update({ where: { id }, data: { endsOn } });
    await this.audit.system({ tenantId, userId, action: 'finance.cost_ended', entityType: 'tenant_cost_item', entityId: id, metadata: { endsOn: input.endsOn } });
    return { ok: true };
  }

  async setBudget(userId: string, tenantId: string, scope: Scope, input: z.infer<typeof budgetSchema>) {
    await this.requireTenant(tenantId);
    await this.db.system.tenantBudget.upsert({
      where: { tenantId_scope: { tenantId, scope } },
      create: { tenantId, scope, amount: input.amount, currency: input.currency, thresholdPct: input.thresholdPct, updatedById: userId },
      update: { amount: input.amount, currency: input.currency, thresholdPct: input.thresholdPct, updatedById: userId },
    });
    await this.audit.system({ tenantId, userId, action: 'finance.budget_set', entityType: 'tenant_budget', entityId: `${tenantId}:${scope}`, metadata: { scope, ...input } });
    return { ok: true };
  }

  async removeBudget(userId: string, tenantId: string, scope: Scope) {
    const r = await this.db.system.tenantBudget.deleteMany({ where: { tenantId, scope } });
    if (!r.count) throw new NotFoundException('Presupuesto no encontrado');
    await this.audit.system({ tenantId, userId, action: 'finance.budget_removed', entityType: 'tenant_budget', entityId: `${tenantId}:${scope}`, metadata: { scope } });
    return { ok: true };
  }

  /** Alertas de consumo: una por empresa, alcance, mes y nivel (la revisa el worker cada hora) */
  async checkBudgets(now = new Date()) {
    const period = currentPeriod(now);
    const tenantIds = [...new Set((await this.db.system.tenantBudget.findMany({ select: { tenantId: true } })).map((b) => b.tenantId))];
    let sent = 0;
    for (const tenantId of tenantIds) {
      const r = await this.tenantReport(tenantId, period, now);
      for (const b of r.budgets) {
        if (!b.level || b.spent == null) continue;
        // Si se pasa directo del presupuesto también queda registrado el aviso del umbral
        const levels = b.level === 'EXCEEDED' ? (['WARN', 'EXCEEDED'] as const) : (['WARN'] as const);
        const created = await this.db.system.budgetAlert.createMany({ data: levels.map((level) => ({ tenantId, scope: b.scope, period, level, spent: b.spent!, budget: b.amount, currency: b.currency })), skipDuplicates: true });
        if (!created.count) continue;
        const admins = await this.db.system.user.findMany({ where: { role: 'PLATFORM_ADMIN', status: 'ACTIVE' }, select: { email: true } });
        const what = b.scope === 'AI' ? 'IA' : 'costos totales';
        const subject = b.level === 'EXCEEDED' ? `${r.tenant.name}: se superó el presupuesto de ${what}` : `${r.tenant.name}: ${what} al ${b.thresholdPct}% del presupuesto`;
        const text = `${r.tenant.name} lleva ${b.spent.toFixed(2)} ${b.currency} de ${b.amount.toFixed(2)} ${b.currency} en ${what} en ${period}.\n\nNada se suspende solo: revisa el consumo y decide.\n\n${this.env.APP_PUBLIC_URL}/plataforma/rentabilidad/${tenantId}`;
        for (const a of admins) await this.mail.send({ to: a.email, subject, text }).catch(() => false);
        await this.db.system.budgetAlert.updateMany({ where: { tenantId, scope: b.scope, period, level: b.level }, data: { recipients: admins.length } });
        await this.audit.system({ tenantId, userId: null, action: 'finance.budget_alert', entityType: 'tenant_budget', entityId: `${tenantId}:${b.scope}`, metadata: { period, level: b.level, spent: b.spent, budget: b.amount, currency: b.currency } });
        sent++;
      }
    }
    return sent;
  }

  alerts(tenantId: string) {
    return this.db.system.budgetAlert.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 24, select: { scope: true, period: true, level: true, spent: true, budget: true, currency: true, recipients: true, createdAt: true } });
  }
}
