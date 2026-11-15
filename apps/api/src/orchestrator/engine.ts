import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { decrypt, encrypt } from '../common/crypto/crypto.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import type { Prisma, ProvisioningRun } from '../generated/prisma/client.js';
import type { ProvisioningStatus } from '../generated/prisma/enums.js';
import { InfraService } from '../infra/infra.service.js';
import { MailService } from '../mail/mail.service.js';
import { SupportService } from '../support/support.service.js';
import { installNo, orderNo } from '../quotes/quote-pdf.js';
import { probeInstallation, type ProbeDeps } from './probe.js';
import { AGENT_STEPS, DEADLINE, FLOW, LABEL, MAX_ATTEMPTS, MONITOR_STALE_MS, POLL, backoff, isActive, serverNameFor } from './steps.js';

/** Resultado de ejecutar un paso */
export type Outcome =
  | { kind: 'next'; to: ProvisioningStatus; message: string; data?: Record<string, unknown>; patch?: Prisma.ProvisioningRunUncheckedUpdateInput }
  | { kind: 'wait'; ms: number; message?: string; data?: Record<string, unknown>; patch?: Prisma.ProvisioningRunUncheckedUpdateInput }
  | { kind: 'retry'; error: string }
  | { kind: 'stop'; error: string; needs: string };

export interface RunSecrets { smtpPassword?: string; bootstrapToken?: string }

const LEASE_MS = 2 * 60_000;
const msgOf = (e: unknown) => {
  if (e instanceof HttpException) {
    const r = e.getResponse() as string | { message?: string | string[]; code?: string };
    const m = typeof r === 'string' ? r : Array.isArray(r.message) ? r.message.join('. ') : (r.message ?? e.message);
    return { message: m, code: typeof r === 'object' ? r.code : undefined, status: e.getStatus() };
  }
  return { message: (e as Error).message ?? String(e), code: undefined, status: 500 };
};
/** Errores del proveedor que conviene reintentar (no son de reglas de negocio) */
const TEMPORARY = new Set(['PROVIDER_RATE_LIMIT', 'PROVIDER_ERROR']);

/**
 * Motor del orquestador (ADR 051). Avanza una ejecución un paso por vez:
 * toma un arriendo (un solo worker a la vez), revisa el plazo del paso, lo
 * ejecuta y guarda el resultado con una actualización condicionada al estado
 * leído (si alguien la canceló o el agente la movió mientras tanto, no se pisa).
 * Todos los pasos son idempotentes: repetirlos no crea un segundo servidor ni
 * un segundo cobro.
 */
@Injectable()
export class ProvisioningEngine {
  private readonly logger = new Logger(ProvisioningEngine.name);
  /** Las pruebas pueden sustituir la resolución DNS y las peticiones HTTPS */
  probeDeps: Partial<ProbeDeps> = {};

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly infra: InfraService,
    private readonly mail: MailService,
    private readonly support: SupportService,
  ) {}

  secrets(run: Pick<ProvisioningRun, 'secretsEnc'>): RunSecrets {
    return run.secretsEnc ? (JSON.parse(decrypt(run.secretsEnc, this.env.DATA_ENCRYPTION_KEY)) as RunSecrets) : {};
  }
  sealSecrets(s: RunSecrets) {
    return encrypt(JSON.stringify(s), this.env.DATA_ENCRYPTION_KEY);
  }

  event(runId: string, status: ProvisioningStatus, level: 'info' | 'warn' | 'error', message: string, source: 'engine' | 'user' | 'agent', data: Record<string, unknown> = {}, userId: string | null = null) {
    return this.db.system.provisioningEvent.create({ data: { runId, status, level, message, source, data: data as Prisma.InputJsonValue, userId } });
  }

  /** Datos para entrar en un paso nuevo */
  enter(to: ProvisioningStatus, now = new Date()): Prisma.ProvisioningRunUncheckedUpdateInput {
    const deadline = DEADLINE[to];
    return {
      status: to, attempts: 0, stepStartedAt: now, stepDeadlineAt: deadline ? new Date(now.getTime() + deadline) : null, lastError: null,
      nextRunAt: !isActive(to) ? null : AGENT_STEPS.includes(to) ? new Date(now.getTime() + (POLL[to] ?? 60_000)) : now,
      ...(to === 'DELIVERED' ? { finishedAt: now, secretsEnc: null, agentHash: null } : {}),
    };
  }

  /** Avanza la ejecución si le toca y nadie más la está procesando */
  async advance(runId: string): Promise<void> {
    const now = new Date();
    const lease = await this.db.system.provisioningRun.updateMany({
      where: { id: runId, status: { in: FLOW }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
    });
    if (lease.count !== 1) return;
    let run: ProvisioningRun | null = null;
    try {
      run = await this.db.system.provisioningRun.findUniqueOrThrow({ where: { id: runId } });
      let out: Outcome;
      if (run.stepDeadlineAt && run.stepDeadlineAt < now) {
        out = { kind: 'stop', error: `Plazo agotado en «${LABEL[run.status]}»`, needs: this.timeoutHelp(run) };
      } else {
        try {
          out = await this.step(run);
        } catch (e) {
          out = { kind: 'retry', error: msgOf(e).message };
        }
      }
      await this.apply(run, out);
    } catch (e) {
      this.logger.error({ err: e, runId }, 'Fallo al avanzar la instalación');
    } finally {
      await this.db.system.provisioningRun.updateMany({ where: { id: runId }, data: { leaseUntil: null } });
    }
  }

  private timeoutHelp(run: ProvisioningRun) {
    switch (run.status) {
      case 'PAYMENT_PENDING': return 'El pago no se validó en 14 días: valida el pago o cancela la instalación.';
      case 'CREATING_INFRA': return 'Nadie aprobó la solicitud del servidor en 3 días: apruébala en Infraestructura › Solicitudes y reintenta, o cancela.';
      case 'SERVER_READY': return 'El servidor no se comunicó con la plataforma: entra por SSH y revisa /var/log/cloud-init-output.log; corrige y reintenta.';
      case 'CONFIGURING_SERVER':
      case 'INSTALLING':
      case 'MIGRATING':
      case 'CONFIGURING_INTEGRATIONS':
        return 'El servidor dejó de informar: entra por SSH y revisa /var/log/aisa-instalacion.log; corrige, vuelve a ejecutar /opt/aisa/agente.sh y reintenta.';
      case 'TESTING': return `El dominio ${run.domain} no respondió por HTTPS: revisa que el registro DNS A apunte al servidor y que los puertos 80 y 443 estén abiertos; luego reintenta.`;
      default: return 'Revisa el historial y reintenta.';
    }
  }

  /** Guarda el resultado sin pisar cambios hechos mientras se ejecutaba el paso */
  async apply(run: ProvisioningRun, out: Outcome) {
    const now = new Date();
    const where = { id: run.id, status: run.status };
    if (out.kind === 'next') {
      const r = await this.db.system.provisioningRun.updateMany({ where, data: { ...this.enter(out.to, now), ...out.patch } as Prisma.ProvisioningRunUncheckedUpdateManyInput });
      if (r.count === 1) await this.event(run.id, out.to, 'info', out.message, 'engine', out.data);
      return;
    }
    if (out.kind === 'wait') {
      const r = await this.db.system.provisioningRun.updateMany({ where, data: { nextRunAt: new Date(now.getTime() + out.ms), ...out.patch } as Prisma.ProvisioningRunUncheckedUpdateManyInput });
      if (r.count === 1 && out.message) await this.event(run.id, run.status, 'info', out.message, 'engine', out.data);
      return;
    }
    if (out.kind === 'retry') {
      const attempts = run.attempts + 1;
      const max = MAX_ATTEMPTS[run.status] ?? 3;
      if (attempts >= max) {
        const r = await this.db.system.provisioningRun.updateMany({ where, data: { status: 'ERROR', stoppedAt: run.status, attempts, lastError: out.error, nextRunAt: null } });
        if (r.count === 1) {
          await this.event(run.id, run.status, 'error', `Falló ${attempts} veces: ${out.error}`, 'engine');
          await this.alert(run.id);
        }
        return;
      }
      const r = await this.db.system.provisioningRun.updateMany({ where, data: { attempts, lastError: out.error, nextRunAt: new Date(now.getTime() + backoff(attempts)) } });
      if (r.count === 1) await this.event(run.id, run.status, 'warn', `Intento ${attempts} de ${max}: ${out.error}`, 'engine');
      return;
    }
    const r = await this.db.system.provisioningRun.updateMany({ where, data: { status: 'NEEDS_INTERVENTION', stoppedAt: run.status, lastError: out.error, needs: out.needs, nextRunAt: null } });
    if (r.count === 1) {
      await this.event(run.id, run.status, 'error', `${out.error}. ${out.needs}`, 'engine');
      await this.alert(run.id);
    }
  }

  /** Aviso por correo al equipo de la plataforma cuando una instalación se detiene */
  async alert(runId: string) {
    const run = await this.db.system.provisioningRun.findUniqueOrThrow({ where: { id: runId } });
    await this.db.system.provisioningRun.update({ where: { id: runId }, data: { alertedAt: new Date() } });
    await this.notifyAdmins(run.id, `Instalación #${run.number} (${run.domain}): ${LABEL[run.status]}`,
      `La instalación #${run.number} de ${run.domain} se detuvo en «${LABEL[run.stoppedAt ?? run.status]}».\n\n${run.lastError ?? ''}\n${run.needs ?? ''}`);
  }

  private async notifyAdmins(runId: string, subject: string, body: string) {
    const admins = await this.db.system.user.findMany({ where: { role: 'PLATFORM_ADMIN', status: 'ACTIVE' }, select: { email: true } });
    const url = `${this.env.APP_PUBLIC_URL}/plataforma/aprovisionamiento/${runId}`;
    for (const a of admins) await this.mail.send({ to: a.email, subject, text: `${body}\n\nVer: ${url}\n` }).catch(() => false);
  }

  /**
   * Monitoreo de las instalaciones entregadas (ADR 052): avisa una sola vez si
   * una deja de reportar o reporta servicios con problemas. El aviso se rearma
   * cuando vuelve a reportar sana.
   */
  async monitorCheck(now = new Date()) {
    const stale = new Date(now.getTime() - MONITOR_STALE_MS);
    const runs = await this.db.system.provisioningRun.findMany({
      where: {
        status: 'DELIVERED', monitorHash: { not: null }, reportAlertedAt: null,
        OR: [{ lastReportAt: { lt: stale } }, { lastReportAt: null, finishedAt: { lt: stale } }, { lastReport: { path: ['healthy'], equals: false } }],
      },
      select: { id: true, number: true, domain: true, lastReportAt: true },
      take: 100,
    });
    for (const r of runs) {
      const u = await this.db.system.provisioningRun.updateMany({ where: { id: r.id, reportAlertedAt: null }, data: { reportAlertedAt: now } });
      if (u.count !== 1) continue;
      const silent = !r.lastReportAt || r.lastReportAt < stale;
      const what = silent
        ? `no reporta desde ${r.lastReportAt ? r.lastReportAt.toISOString() : 'la entrega'} (cada 10 minutos debería)`
        : 'reporta servicios con problemas';
      await this.event(r.id, 'DELIVERED', 'warn', `Monitoreo: la instalación ${what}`, 'engine');
      // Incidencia en el centro de soporte, una por instalación mientras siga abierta
      await this.support.openMonitorIncident(r.id, `Instalación ${r.domain}: ${silent ? 'no reporta' : 'servicios con problemas'}`, `El monitoreo detectó que la instalación #${r.number} (${r.domain}) ${what}.`).catch(() => null);
      await this.notifyAdmins(r.id, `Instalación #${r.number} (${r.domain}): ${silent ? 'sin reportar' : 'servicios con problemas'}`,
        `La instalación #${r.number} de ${r.domain} ${what}.\n\nEntra por SSH y revisa ./salud.sh en /opt/aisa/instalacion y el registro /var/log/aisa-reporte.log.`);
    }
    return runs.length;
  }


  private step(run: ProvisioningRun): Promise<Outcome> {
    switch (run.status) {
      case 'REQUESTED':
      case 'PAYMENT_PENDING':
        return this.payment(run);
      case 'PAYMENT_CONFIRMED':
        return this.confirmed(run);
      case 'PREPARING':
        return this.preparing(run);
      case 'CREATING_INFRA':
        return this.creatingInfra(run);
      case 'SERVER_READY':
        return Promise.resolve(run.bootstrapUsedAt ? { kind: 'next', to: 'CONFIGURING_SERVER', message: 'El servidor se comunicó con la plataforma y empezó a configurarse' } : { kind: 'wait', ms: POLL.SERVER_READY! });
      case 'CONFIGURING_SERVER':
      case 'INSTALLING':
      case 'MIGRATING':
      case 'CONFIGURING_INTEGRATIONS':
        // Los informa el agente; aquí solo se vigila el plazo
        return Promise.resolve({ kind: 'wait', ms: POLL[run.status]! });
      case 'TESTING':
        return this.testing(run);
      case 'PUBLISHING':
        return this.publishing(run);
      case 'DELIVERING':
        return this.delivering(run);
      default:
        return Promise.resolve({ kind: 'wait', ms: 60_000 });
    }
  }

  private async payment(run: ProvisioningRun): Promise<Outcome> {
    const o = await this.db.system.installationOrder.findUniqueOrThrow({ where: { id: run.installationOrderId }, include: { paymentOrder: { select: { status: true, number: true } } } });
    if (o.status === 'CANCELLED' || o.status === 'DONE') return { kind: 'stop', error: `La orden ${installNo(o.number)} está ${o.status === 'DONE' ? 'terminada' : 'cancelada'}`, needs: 'Revisa la orden de instalación; si no corresponde instalar, cancela.' };
    if (o.paymentOrder.status !== 'PAID') {
      return run.status === 'PAYMENT_PENDING' ? { kind: 'wait', ms: POLL.PAYMENT_PENDING! } : { kind: 'next', to: 'PAYMENT_PENDING', message: `El pago ${orderNo(o.paymentOrder.number)} aún no está validado` };
    }
    return { kind: 'next', to: 'PAYMENT_CONFIRMED', message: `Pago ${orderNo(o.paymentOrder.number)} validado` };
  }

  private async confirmed(run: ProvisioningRun): Promise<Outcome> {
    await this.db.system.installationOrder.updateMany({ where: { id: run.installationOrderId, status: 'AUTHORIZED' }, data: { status: 'IN_PROGRESS' } });
    return { kind: 'next', to: 'PREPARING', message: 'Orden de instalación en curso' };
  }

  /** Verifica empresa y entrega (las crea la API al registrar o reintentar) y genera el token de arranque */
  private async preparing(run: ProvisioningRun): Promise<Outcome> {
    const o = await this.db.system.installationOrder.findUniqueOrThrow({ where: { id: run.installationOrderId }, include: { tenant: { select: { name: true, deploymentMode: true } } } });
    if (!o.tenant) return { kind: 'stop', error: 'La orden aún no tiene empresa', needs: 'Convierte al prospecto en cliente (crea la empresa) desde su ficha y reintenta.' };
    if (o.tenant.deploymentMode === 'SAAS') return { kind: 'stop', error: 'La empresa está en modalidad SaaS', needs: 'Las empresas SaaS viven en la plataforma central y no necesitan servidor; cancela esta instalación o cambia la modalidad.' };
    const deliveryId = (run.settings as { deliveryId?: string }).deliveryId;
    if (!deliveryId) return { kind: 'stop', error: 'Falta preparar la entrega', needs: 'Reintenta: la plataforma prepara la entrega de la empresa al reintentar.' };
    const secrets = this.secrets(run);
    if (secrets.bootstrapToken) return { kind: 'next', to: 'CREATING_INFRA', message: 'Instalación preparada' };
    const { randomBytes, createHash } = await import('node:crypto');
    const token = randomBytes(32).toString('base64url');
    return {
      kind: 'next', to: 'CREATING_INFRA', message: `Instalación preparada para ${o.tenant.name}: entrega lista y token de arranque generado`,
      patch: { secretsEnc: this.sealSecrets({ ...secrets, bootstrapToken: token }), bootstrapHash: createHash('sha256').update(token).digest('hex') },
    };
  }

  private async creatingInfra(run: ProvisioningRun): Promise<Outcome> {
    if (!run.serverRequestId) {
      const order = await this.db.system.installationOrder.findUniqueOrThrow({ where: { id: run.installationOrderId }, select: { number: true } });
      try {
        const r = await this.infra.createRequest(run.createdById, {
          providerId: run.providerId, installationOrderId: run.installationOrderId, name: serverNameFor(run.domain, run.number), serverType: run.serverType, location: run.location,
          purpose: `Instalación ${installNo(order.number)} · aprovisionamiento #${run.number} · ${run.domain}`,
        });
        return { kind: 'wait', ms: POLL.CREATING_INFRA!, patch: { serverRequestId: r.id }, message: `Solicitud de servidor #${r.number} registrada (${r.serverType} en ${r.location}, ${Number(r.priceMonthly).toFixed(2)} ${r.currency}/mes): falta que una persona la apruebe en Infraestructura`, data: { requestId: r.id } };
      } catch (e) {
        const m = msgOf(e);
        if (m.code && TEMPORARY.has(m.code)) return { kind: 'retry', error: m.message };
        if (m.status < 500) return { kind: 'stop', error: `No se pudo pedir el servidor: ${m.message}`, needs: 'Corrige el proveedor o sus límites en Infraestructura y reintenta.' };
        throw e;
      }
    }
    const req = await this.db.system.infraServerRequest.findUniqueOrThrow({ where: { id: run.serverRequestId }, include: { server: true } });
    if (req.status === 'PENDING_APPROVAL' || req.status === 'CREATING') return { kind: 'wait', ms: POLL.CREATING_INFRA! };
    if (req.status === 'REJECTED' || req.status === 'CANCELLED') return { kind: 'stop', error: `La solicitud de servidor #${req.number} fue ${req.status === 'REJECTED' ? 'rechazada' : 'cancelada'}${req.decisionNote ? `: ${req.decisionNote}` : ''}`, needs: 'Reintenta para pedir otro servidor, o cancela la instalación.' };
    if (req.status === 'FAILED') return { kind: 'stop', error: `No se pudo crear el servidor: ${req.error ?? 'error del proveedor'}`, needs: 'Revisa el error en Infraestructura; al reintentar se pide un servidor nuevo.' };
    const server = req.server;
    if (!server) return { kind: 'retry', error: 'La solicitud figura creada pero no hay servidor registrado' };
    let status = server.status;
    let ipv4 = server.ipv4;
    try {
      const s = await this.infra.refresh(run.createdById, server.id);
      status = s.status;
      ipv4 = s.ipv4;
    } catch (e) {
      return { kind: 'retry', error: msgOf(e).message };
    }
    if (status === 'missing') return { kind: 'stop', error: 'El servidor ya no existe en el proveedor', needs: 'Revisa la cuenta del proveedor; al reintentar se pide un servidor nuevo.' };
    if (status !== 'running') return { kind: 'wait', ms: POLL.SERVER_READY!, patch: { serverId: server.id } };
    return { kind: 'next', to: 'SERVER_READY', message: `Servidor ${server.name} en marcha (${ipv4 ?? 'sin IPv4'})`, patch: { serverId: server.id }, data: { serverId: server.id, ipv4 } };
  }

  private async serverIp(run: ProvisioningRun) {
    if (!run.serverId) return null;
    return (await this.db.system.infraServer.findUnique({ where: { id: run.serverId }, select: { ipv4: true } }))?.ipv4 ?? null;
  }

  private async testing(run: ProvisioningRun): Promise<Outcome> {
    const r = await probeInstallation(run.domain, await this.serverIp(run), this.probeDeps);
    if (!r.ok) return { kind: 'retry', error: r.error };
    return { kind: 'next', to: 'PUBLISHING', message: `Pruebas superadas: ${r.detail}`, data: { checks: r.checks } };
  }

  private async publishing(run: ProvisioningRun): Promise<Outcome> {
    const r = await probeInstallation(run.domain, await this.serverIp(run), this.probeDeps, 'panel');
    if (!r.ok) return { kind: 'retry', error: r.error };
    return { kind: 'next', to: 'DELIVERING', message: `Panel publicado: https://${run.domain} con certificado válido` };
  }

  private async delivering(run: ProvisioningRun): Promise<Outcome> {
    const o = await this.db.system.installationOrder.findUniqueOrThrow({ where: { id: run.installationOrderId }, select: { number: true, tenantId: true } });
    const deliveryId = (run.settings as { deliveryId?: string }).deliveryId;
    await this.db.system.$transaction(async (tx) => {
      await tx.installationOrder.updateMany({ where: { id: run.installationOrderId, status: { in: ['AUTHORIZED', 'IN_PROGRESS'] } }, data: { status: 'DONE' } });
      if (run.serverId && o.tenantId) await tx.infraServer.update({ where: { id: run.serverId }, data: { tenantId: o.tenantId } });
      if (deliveryId) await tx.delivery.updateMany({ where: { id: deliveryId, status: 'GENERATED' }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    });
    await this.audit.system({ tenantId: o.tenantId, userId: null, action: 'provisioning.delivered', entityType: 'provisioning_run', entityId: run.id, metadata: { domain: run.domain, installation: installNo(o.number) } });
    const sent = await this.mail.send({
      to: run.adminEmail,
      subject: `Tu sistema está listo: https://${run.domain}`,
      text: [
        `Hola:`, '',
        `La instalación de AI Sales Assistant en https://${run.domain} está lista.`, '',
        `Usuario administrador: ${run.adminEmail}`,
        `Para crear tu contraseña entra a https://${run.domain}/login y usa «¿Olvidaste tu contraseña?»: el correo llega desde tu propio servidor.`, '',
        'La contraseña inicial se generó en el servidor y la plataforma no la conoce.',
      ].join('\n'),
    }).catch(() => false);
    if (!sent) await this.event(run.id, 'DELIVERING', 'warn', `No se pudo enviar el correo de entrega a ${run.adminEmail}: avisa al cliente por otro medio`, 'engine');
    return { kind: 'next', to: 'DELIVERED', message: `Instalación entregada a ${run.adminEmail}; orden ${installNo(o.number)} terminada` };
  }
}
