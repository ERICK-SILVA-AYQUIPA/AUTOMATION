import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { subscriptionAccess } from '../plans/subscription-access.js';
import { logSalesActivity } from '../sales/sales.service.js';
import { MailService } from '../mail/mail.service.js';

const DAY = 86_400_000;
export type NoticeKind = 'D7' | 'D3' | 'D1' | 'EXPIRED';

/** Qué aviso corresponde según los días que faltan para el fin del periodo (o de la prueba) */
export function noticeFor(endsAt: Date, now = new Date()): NoticeKind | null {
  const ms = endsAt.getTime() - now.getTime();
  if (ms <= 0) return ms > -30 * DAY ? 'EXPIRED' : null;
  const days = ms / DAY;
  return days <= 1 ? 'D1' : days <= 3 ? 'D3' : days <= 7 ? 'D7' : null;
}

const fmt = (d: Date) => d.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Lima' });

/**
 * Renovaciones (ADR 054): avisos de vencimiento a los administradores de cada
 * empresa (7, 3 y 1 día antes y al vencer, una sola vez por periodo) y una
 * próxima acción en el prospecto del centro comercial para el seguimiento. El
 * cobro sigue siendo manual: nada se cobra solo.
 */
@Injectable()
export class RenewalsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly mail: MailService,
  ) {}

  /** Lo ejecuta el worker cada hora; es idempotente (índice único por periodo y tipo) */
  async sendNotices(now = new Date()) {
    const subs = await this.db.system.subscription.findMany({
      where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] }, tenant: { status: { not: 'SUSPENDED' } } },
      select: { tenantId: true, status: true, trialEndsAt: true, currentPeriodEnd: true, plan: { select: { name: true } }, tenant: { select: { name: true } } },
    });
    let sent = 0;
    for (const s of subs) {
      const end = s.status === 'TRIALING' ? (s.trialEndsAt ?? s.currentPeriodEnd) : s.currentPeriodEnd;
      const kind = noticeFor(end, now);
      if (!kind) continue;
      const created = await this.db.system.subscriptionNotice.createMany({ data: [{ tenantId: s.tenantId, periodEnd: end, kind }], skipDuplicates: true });
      if (!created.count) continue;
      const admins = await this.db.system.user.findMany({ where: { tenantId: s.tenantId, role: 'TENANT_ADMIN', status: 'ACTIVE' }, select: { email: true } });
      const trial = s.status === 'TRIALING';
      const what = trial ? 'Tu periodo de prueba' : `Tu plan ${s.plan.name}`;
      const subject = kind === 'EXPIRED' ? `${what} venció` : `${what} vence el ${fmt(end)}`;
      const access = subscriptionAccess({ status: s.status, trialEndsAt: s.trialEndsAt, currentPeriodEnd: s.currentPeriodEnd }, this.env.BILLING_GRACE_DAYS, now);
      const text = kind === 'EXPIRED'
        ? `${what} de ${s.tenant.name} venció el ${fmt(end)}.${access.readOnly ? ' La cuenta está en solo lectura: tus datos se conservan.' : ` Tienes hasta el ${fmt(new Date(access.graceEndsAt!))} para renovar sin interrupciones.`}\n\nPara renovar, responde este correo o escríbenos desde Soporte en tu panel.`
        : `${what} de ${s.tenant.name} vence el ${fmt(end)}. Para seguir sin interrupciones, renueva antes de esa fecha.\n\nPara renovar, responde este correo o escríbenos desde Soporte en tu panel: ${this.env.APP_PUBLIC_URL}/soporte`;
      for (const a of admins) await this.mail.send({ to: a.email, subject, text }).catch(() => false);
      await this.db.system.subscriptionNotice.update({ where: { tenantId_periodEnd_kind: { tenantId: s.tenantId, periodEnd: end, kind } }, data: { recipients: admins.length } });
      await this.followUp(s.tenantId, end, kind);
      sent++;
    }
    return sent;
  }

  /** Seguimiento comercial: la renovación aparece como próxima acción en el prospecto convertido */
  private async followUp(tenantId: string, end: Date, kind: NoticeKind) {
    const lead = await this.db.system.salesLead.findUnique({ where: { tenantId }, select: { id: true, nextAction: true } });
    if (!lead) return;
    const body = kind === 'EXPIRED' ? `Renovación: venció el ${fmt(end)}` : `Renovación: vence el ${fmt(end)}`;
    await this.db.system.$transaction(async (tx) => {
      await logSalesActivity(tx, lead.id, null, 'NOTE', `Aviso de vencimiento enviado (${kind === 'EXPIRED' ? 'vencido' : kind.slice(1) + ' día(s) antes'})`, { renewal: kind, periodEnd: end.toISOString() });
      if (!lead.nextAction) {
        await tx.salesLead.update({ where: { id: lead.id }, data: { nextAction: body, nextActionAt: new Date() } });
        await logSalesActivity(tx, lead.id, null, 'NEXT_ACTION_SET', body, { renewal: kind });
      }
    });
  }

  /** Panel de renovaciones: vencen en 30 días, en gracia o vencidas hace menos de 30 */
  async list(now = new Date()) {
    const subs = await this.db.system.subscription.findMany({
      where: {
        status: { not: 'CANCELED' },
        OR: [{ currentPeriodEnd: { lte: new Date(now.getTime() + 30 * DAY), gte: new Date(now.getTime() - 30 * DAY) } }, { status: 'TRIALING', trialEndsAt: { lte: new Date(now.getTime() + 30 * DAY), gte: new Date(now.getTime() - 30 * DAY) } }],
      },
      orderBy: { currentPeriodEnd: 'asc' },
      select: {
        tenantId: true, status: true, trialEndsAt: true, currentPeriodEnd: true, plan: { select: { code: true, name: true, priceMonthly: true, currency: true } },
        tenant: { select: { id: true, name: true, status: true, deploymentMode: true, subscriptionNotices: { orderBy: { createdAt: 'desc' }, take: 4, select: { kind: true, createdAt: true, periodEnd: true, recipients: true } } } },
      },
    });
    return subs.map((s) => ({
      ...s,
      access: subscriptionAccess({ status: s.status, trialEndsAt: s.trialEndsAt, currentPeriodEnd: s.currentPeriodEnd }, this.env.BILLING_GRACE_DAYS, now),
      notices: s.tenant.subscriptionNotices.filter((n) => n.periodEnd.getTime() === (s.status === 'TRIALING' ? (s.trialEndsAt ?? s.currentPeriodEnd) : s.currentPeriodEnd).getTime()),
    })).sort((x, y) => x.access.endsAt.localeCompare(y.access.endsAt));
  }
}
