import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import type { InstanceReport } from '../orchestrator/instance-status.js';
import { computeOnboarding } from '../tenants/onboarding.js';
import { type JourneyData, buildJourney } from './journey.js';

/** Asistente «Nueva venta e instalación» (ADR 053): solo lectura, con datos reales */
@Injectable()
export class JourneyService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
  ) {}

  private async load(leadId: string): Promise<JourneyData> {
    const db = this.db.system;
    const lead = await db.salesLead.findUnique({
      where: { id: leadId },
      select: { id: true, number: true, name: true, company: true, email: true, status: true, interestPlan: true, interestMode: true, interestModules: true, tenantId: true },
    });
    if (!lead) throw new NotFoundException('Prospecto no encontrado');
    const quotes = await db.salesQuote.findMany({ where: { leadId, status: { not: 'CANCELLED' } }, orderBy: { number: 'desc' }, select: { id: true, number: true, status: true, planCode: true, deploymentMode: true, modules: true } });
    const quote = quotes.find((q) => q.status === 'ACCEPTED') ?? quotes[0] ?? null;
    const payments = await db.salesPaymentOrder.findMany({ where: { leadId, status: { not: 'CANCELLED' } }, orderBy: { number: 'desc' }, select: { id: true, number: true, status: true, quoteId: true } });
    const payment = payments.find((p) => p.status === 'PAID' && (!quote || p.quoteId === quote.id)) ?? payments.find((p) => !quote || p.quoteId === quote.id) ?? payments[0] ?? null;
    const installation = await db.installationOrder.findFirst({ where: { leadId, status: { not: 'CANCELLED' } }, orderBy: { number: 'desc' }, select: { id: true, number: true, status: true, deploymentMode: true, tenantId: true } });
    const tenantId = lead.tenantId ?? installation?.tenantId ?? null;
    const tenant = tenantId ? await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, status: true, deploymentMode: true } }) : null;
    const runs = installation ? await db.provisioningRun.findMany({
      where: { installationOrderId: installation.id }, orderBy: { number: 'desc' },
      select: { id: true, number: true, status: true, stoppedAt: true, lastError: true, needs: true, domain: true, lastReport: true, lastReportAt: true, serverRequest: { select: { number: true, status: true } }, server: { select: { name: true, ipv4: true, deletedAt: true } } },
    }) : [];
    const run = runs.find((r) => r.status !== 'CANCELLED') ?? runs[0] ?? null;
    const onboarding = tenant && tenant.deploymentMode === 'SAAS'
      ? (await db.$transaction((tx) => computeOnboarding(tx, tenant.id, { graceDays: this.env.BILLING_GRACE_DAYS, aiProviderConfigured: !!this.env.GEMINI_API_KEY, checkInvitations: true }))).tasks
      : null;
    return {
      lead, quote, tenant, onboarding,
      payment: payment && { id: payment.id, number: payment.number, status: payment.status },
      installation: installation && { id: installation.id, number: installation.number, status: installation.status, deploymentMode: installation.deploymentMode },
      run: run && { ...run, lastReport: run.lastReport as InstanceReport | null },
    };
  }

  async get(leadId: string) {
    const d = await this.load(leadId);
    return { lead: d.lead, tenant: d.tenant, ...buildJourney(d) };
  }

  /** Ventas en curso: prospectos abiertos con el paso en que están */
  async list() {
    const leads = await this.db.system.salesLead.findMany({
      where: { status: { notIn: ['LOST', 'NEW', 'CONTACTED'] } },
      orderBy: { statusChangedAt: 'desc' }, take: 30, select: { id: true },
    });
    const out = [];
    for (const l of leads) {
      const j = await this.get(l.id);
      if (j.done === j.steps.length) continue;
      const step = j.steps[j.current - 1]!;
      out.push({ leadId: l.id, number: j.lead.number, name: j.lead.company ?? j.lead.name, current: j.current, total: j.steps.length, done: j.done, step: step.title, missing: step.missing[0] ?? null });
    }
    return out;
  }
}
