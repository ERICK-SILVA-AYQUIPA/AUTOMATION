import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { DeliveriesService } from '../deliveries/deliveries.service.js';
import { APP_VERSION } from '../deliveries/version.js';
import type { Prisma, ProvisioningRun } from '../generated/prisma/client.js';
import type { ProvisioningStatus } from '../generated/prisma/enums.js';
import { InfraService, deleteSchema } from '../infra/infra.service.js';
import { Queues } from '../queues/queues.module.js';
import { installNo } from '../quotes/quote-pdf.js';
import { agentEnv, agentScript, cloudInit } from './agent.js';
import { ProvisioningEngine } from './engine.js';
import { type InstanceReport, reportSignature, reportSummary } from './instance-status.js';
import { AGENT_STEPS, FINAL, FLOW, LABEL, STOPPED, agentReport, cleanText, nextOf } from './steps.js';

const hostname = z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Dominio no válido (p. ej. ventas.miempresa.pe)');
const code = z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/);
const line = (max: number) => z.string().trim().max(max).refine((v) => !/[\r\n'"`$\\]/.test(v), 'No uses comillas, $, \\ ni saltos de línea');

export const runSchema = z.object({
  installationOrderId: z.uuid(),
  providerId: z.uuid(),
  serverType: code,
  location: code,
  domain: hostname,
  adminEmail: z.email().max(200),
  systemName: line(120).pipe(z.string().min(2)),
  supportContact: line(300).pipe(z.string().min(5)),
  smtp: z.object({
    host: hostname,
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: line(200),
    /** Se guarda cifrada, se entrega una sola vez al servidor y se borra al terminar */
    password: z.string().max(500).refine((v) => !/[\r\n]/.test(v), 'Sin saltos de línea').optional(),
    from: line(200).pipe(z.string().min(3)),
  }),
});
export const cancelSchema = z.object({
  reason: z.string().trim().min(5, 'Escribe el motivo').max(1000),
  /** Compensación explícita: eliminar el servidor creado (exige escribir su nombre) */
  releaseServer: z.object({ confirmName: z.string().trim() }).optional(),
});
export const reportSchema = z.object({
  step: z.enum(AGENT_STEPS as [ProvisioningStatus, ...ProvisioningStatus[]]),
  state: z.enum(['started', 'progress', 'done', 'failed']),
  message: z.string().max(4000).default(''),
});

const SAFE = {
  id: true, number: true, installationOrderId: true, providerId: true, serverType: true, location: true, domain: true, adminEmail: true, settings: true,
  status: true, stoppedAt: true, attempts: true, nextRunAt: true, stepStartedAt: true, stepDeadlineAt: true, lastError: true, needs: true,
  serverRequestId: true, serverId: true, bootstrapExpiresAt: true, bootstrapUsedAt: true, agentSeenAt: true, alertedAt: true, cancelReason: true,
  createdById: true, createdAt: true, updatedAt: true, finishedAt: true, lastReportAt: true, lastReport: true, reportAlertedAt: true,
} as const;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const sameHash = (hash: string | null, token: string) => !!hash && token.length >= 20 && timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(sha(token), 'hex'));
const LINK_ERROR = () => new NotFoundException({ code: 'PROVISIONING_LINK', message: 'Credencial de instalación no válida' });

/**
 * Orquestador de aprovisionamiento (ADR 051), lado de la API: registrar,
 * reintentar y cancelar instalaciones; canal del agente del servidor nuevo
 * (arranque de un solo uso, informes, paquete e imágenes) y el cloud-init que
 * se entrega al crear el servidor. El avance lo hace el worker (engine.ts).
 */
@Injectable()
export class OrchestratorService implements OnModuleInit {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly infra: InfraService,
    private readonly deliveries: DeliveriesService,
    private readonly engine: ProvisioningEngine,
    private readonly queues: Queues,
  ) {}

  onModuleInit() {
    this.infra.setUserDataProvider((requestId) => this.userDataFor(requestId));
  }

  kick(runId: string) {
    return this.queues.kickProvisioning(runId);
  }

  /** Archivo de imágenes de esta versión que el servidor nuevo descarga (export-images.sh) */
  imagesFile() {
    const dir = this.env.PROVISIONING_IMAGES_DIR;
    if (!dir) return null;
    const file = join(dir, `aisa-imagenes-${APP_VERSION}.tar.gz`);
    const sum = `${file}.sha256`;
    if (!existsSync(file) || !existsSync(sum)) return null;
    return { file, sha256: readFileSync(sum, 'utf8').trim().split(/\s+/)[0]!, bytes: statSync(file).size };
  }

  async options() {
    const [orders, providers] = await Promise.all([
      this.db.system.installationOrder.findMany({
        where: { status: { in: ['AUTHORIZED', 'IN_PROGRESS'] }, provisioningRuns: { none: { status: { not: 'CANCELLED' } } } },
        orderBy: { number: 'desc' },
        select: { id: true, number: true, deploymentMode: true, planCode: true, serverResources: true, lead: { select: { name: true, company: true, email: true } }, tenant: { select: { id: true, name: true, deploymentMode: true } } },
      }),
      this.db.system.infraProvider.findMany({ where: { disabledAt: null, status: 'CONNECTED' }, select: { id: true, label: true, kind: true, currency: true, allowedLocations: true, allowedServerTypes: true } }),
    ]);
    const img = this.imagesFile();
    return { orders, providers, version: APP_VERSION, images: img ? { sha256: img.sha256, bytes: img.bytes } : null, apiPublicUrl: this.env.API_PUBLIC_URL };
  }

  async list(status?: ProvisioningStatus) {
    const runs = await this.db.system.provisioningRun.findMany({
      where: status ? { status } : {},
      orderBy: { number: 'desc' },
      take: 200,
      select: { ...SAFE, installationOrder: { select: { number: true, lead: { select: { name: true, company: true } } } }, server: { select: { name: true, ipv4: true, status: true, deletedAt: true } } },
    });
    return runs;
  }

  async get(id: string) {
    const r = await this.db.system.provisioningRun.findUnique({
      where: { id },
      select: {
        ...SAFE,
        installationOrder: { select: { id: true, number: true, status: true, tenant: { select: { id: true, name: true } }, lead: { select: { id: true, name: true, company: true } } } },
        provider: { select: { id: true, label: true, kind: true } },
        serverRequest: { select: { id: true, number: true, status: true, name: true, priceMonthly: true, currency: true, error: true, decisionNote: true } },
        server: { select: { id: true, name: true, ipv4: true, ipv6: true, status: true, deletedAt: true } },
        events: { orderBy: { createdAt: 'asc' }, select: { id: true, status: true, level: true, message: true, source: true, data: true, userId: true, createdAt: true } },
      },
    });
    if (!r) throw new NotFoundException('Instalación no encontrada');
    const m = await this.db.system.provisioningRun.findUniqueOrThrow({ where: { id }, select: { monitorHash: true } });
    return { ...r, monitoring: !!m.monitorHash, flow: FLOW, labels: LABEL };
  }

  /** Lo que se necesita antes de empezar o reintentar; deja la entrega preparada */
  private async ensurePrepared(userId: string, run: Pick<ProvisioningRun, 'id' | 'installationOrderId' | 'domain' | 'settings'>) {
    const settings = run.settings as { deliveryId?: string; systemName: string; supportContact: string };
    if (settings.deliveryId) return settings;
    const o = await this.db.system.installationOrder.findUniqueOrThrow({ where: { id: run.installationOrderId }, select: { tenantId: true, tenant: { select: { deploymentMode: true } } } });
    if (!o.tenantId || o.tenant?.deploymentMode === 'SAAS') return settings; // el paso «Preparando» lo explica
    const d = await this.deliveries.create(userId, o.tenantId, { systemName: settings.systemName, domain: run.domain, supportContact: settings.supportContact });
    const next = { ...settings, deliveryId: d.id };
    await this.db.system.provisioningRun.update({ where: { id: run.id }, data: { settings: next } });
    return next;
  }

  async create(userId: string, input: z.infer<typeof runSchema>) {
    const o = await this.db.system.installationOrder.findUnique({ where: { id: input.installationOrderId }, select: { id: true, number: true, status: true, deploymentMode: true } });
    if (!o) throw new NotFoundException('Orden de instalación no encontrada');
    if (o.status !== 'AUTHORIZED' && o.status !== 'IN_PROGRESS') throw new ConflictException({ code: 'INSTALLATION_CLOSED', message: `La orden ${installNo(o.number)} no está vigente` });
    if (o.deploymentMode === 'SAAS') throw new ConflictException({ code: 'SAAS_NO_SERVER', message: 'La orden es SaaS: la empresa vive en la plataforma central y no necesita servidor' });
    const live = await this.db.system.provisioningRun.findFirst({ where: { installationOrderId: o.id, status: { not: 'CANCELLED' } }, select: { number: true } });
    if (live) throw new ConflictException({ code: 'RUN_EXISTS', message: `La orden ${installNo(o.number)} ya tiene la instalación #${live.number}` });
    const p = await this.db.system.infraProvider.findUnique({ where: { id: input.providerId }, select: { id: true, disabledAt: true, status: true } });
    if (!p) throw new NotFoundException('Proveedor no encontrado');
    if (p.disabledAt || p.status !== 'CONNECTED') throw new ConflictException({ code: 'PROVIDER_NOT_CONNECTED', message: 'El proveedor no está conectado' });
    if (!this.imagesFile()) throw new ConflictException({ code: 'NO_IMAGES', message: `Faltan las imágenes de la versión ${APP_VERSION}: genéralas con infrastructure/scripts/export-images.sh y define PROVISIONING_IMAGES_DIR` });
    const { smtp, systemName, supportContact, ...rest } = input;
    const run = await this.db.system.provisioningRun.create({
      data: {
        ...rest, createdById: userId,
        settings: { systemName, supportContact, smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, from: smtp.from } },
        secretsEnc: smtp.password ? this.engine.sealSecrets({ smtpPassword: smtp.password }) : null,
        nextRunAt: new Date(),
      },
    });
    await this.engine.event(run.id, 'REQUESTED', 'info', `Instalación registrada para ${run.domain} (${installNo(o.number)})`, 'user', { serverType: run.serverType, location: run.location }, userId);
    await this.audit.system({ tenantId: null, userId, action: 'provisioning.created', entityType: 'provisioning_run', entityId: run.id, metadata: { domain: run.domain, installation: installNo(o.number) } });
    await this.ensurePrepared(userId, run).catch(async (e: Error) => this.engine.event(run.id, 'REQUESTED', 'warn', `La entrega se preparará al reintentar: ${e.message}`, 'engine'));
    await this.kick(run.id);
    return this.get(run.id);
  }

  async retry(userId: string, id: string) {
    const run = await this.db.system.provisioningRun.findUnique({ where: { id }, include: { serverRequest: { select: { status: true } } } });
    if (!run) throw new NotFoundException('Instalación no encontrada');
    if (!STOPPED.includes(run.status) || !run.stoppedAt) throw new ConflictException({ code: 'NOT_STOPPED', message: 'Solo se reintenta una instalación detenida' });
    const to = run.stoppedAt;
    if (FLOW.indexOf(to) >= FLOW.indexOf('PREPARING')) await this.ensurePrepared(userId, run);
    // Una solicitud rechazada, cancelada o fallida no se reutiliza: se pide otra
    const dropRequest = to === 'CREATING_INFRA' && run.serverRequest && ['REJECTED', 'CANCELLED', 'FAILED'].includes(run.serverRequest.status);
    const r = await this.db.system.provisioningRun.updateMany({
      where: { id, status: run.status },
      data: { ...this.engine.enter(to), stoppedAt: null, needs: null, ...(dropRequest ? { serverRequestId: null } : {}) } as Prisma.ProvisioningRunUncheckedUpdateManyInput,
    });
    if (r.count !== 1) throw new ConflictException({ code: 'RUN_CHANGED', message: 'La instalación cambió: recarga' });
    await this.engine.event(id, to, 'info', `Reintento desde «${LABEL[to]}»`, 'user', {}, userId);
    await this.audit.system({ tenantId: null, userId, action: 'provisioning.retried', entityType: 'provisioning_run', entityId: id, metadata: { step: to } });
    await this.kick(id);
    return this.get(id);
  }

  async cancel(userId: string, id: string, input: z.infer<typeof cancelSchema>) {
    const run = await this.db.system.provisioningRun.findUnique({ where: { id }, include: { server: true, serverRequest: true } });
    if (!run) throw new NotFoundException('Instalación no encontrada');
    if (FINAL.includes(run.status)) throw new ConflictException({ code: 'RUN_CLOSED', message: `La instalación ya está ${LABEL[run.status].toLowerCase()}` });
    const server = run.server && !run.server.deletedAt ? run.server : null;
    if (input.releaseServer && !server) throw new BadRequestException({ code: 'NO_SERVER', message: 'La instalación no tiene un servidor activo' });
    if (input.releaseServer && input.releaseServer.confirmName !== server!.name) throw new BadRequestException({ code: 'CONFIRM_NAME', message: `Escribe el nombre exacto del servidor (${server!.name}) para eliminarlo` });
    const r = await this.db.system.provisioningRun.updateMany({
      where: { id, status: run.status },
      data: { status: 'CANCELLED', stoppedAt: null, cancelReason: input.reason, nextRunAt: null, finishedAt: new Date(), agentHash: null, monitorHash: null, secretsEnc: null },
    });
    if (r.count !== 1) throw new ConflictException({ code: 'RUN_CHANGED', message: 'La instalación cambió: recarga' });
    await this.engine.event(id, 'CANCELLED', 'info', `Cancelada: ${input.reason}`, 'user', {}, userId);
    await this.audit.system({ tenantId: null, userId, action: 'provisioning.cancelled', entityType: 'provisioning_run', entityId: id, metadata: { reason: input.reason, releaseServer: !!input.releaseServer } });
    // Compensaciones: nada que genere costo queda pendiente sin que una persona lo decida
    if (run.serverRequest?.status === 'PENDING_APPROVAL') {
      await this.infra.reject(userId, run.serverRequest.id, `Instalación #${run.number} cancelada: ${input.reason}`, 'CANCELLED');
      await this.engine.event(id, 'CANCELLED', 'info', `Solicitud de servidor #${run.serverRequest.number} cancelada`, 'engine');
    }
    if (server && input.releaseServer) {
      await this.infra.remove(userId, server.id, deleteSchema.parse({ confirmName: input.releaseServer.confirmName, reason: `Instalación #${run.number} cancelada: ${input.reason}` }));
      await this.engine.event(id, 'CANCELLED', 'info', `Servidor ${server.name} eliminado`, 'user', {}, userId);
    } else if (server) {
      await this.engine.event(id, 'CANCELLED', 'warn', `El servidor ${server.name} sigue activo y genera costo: elimínalo en Infraestructura si no se usará`, 'engine');
    }
    return this.get(id);
  }

  // ---------------------------------------------------------------- Servidor nuevo (agente)

  /** cloud-init del servidor de una instalación (lo pide InfraService al aprobar) */
  async userDataFor(requestId: string) {
    const run = await this.db.system.provisioningRun.findFirst({ where: { serverRequestId: requestId, status: 'CREATING_INFRA' } });
    if (!run) return undefined;
    const token = this.engine.secrets(run).bootstrapToken;
    if (!token) throw new Error('La instalación no tiene token de arranque');
    await this.db.system.provisioningRun.update({ where: { id: run.id }, data: { bootstrapExpiresAt: new Date(Date.now() + 6 * 3_600_000), bootstrapUsedAt: null } });
    return cloudInit({ apiUrl: this.env.API_PUBLIC_URL, runId: run.id, token });
  }

  /** Arranque: un solo uso, con plazo; entrega el agente y su configuración */
  async bootstrap(id: string, token: string) {
    const run = await this.db.system.provisioningRun.findUnique({ where: { id } });
    if (!run || !sameHash(run.bootstrapHash, token)) throw LINK_ERROR();
    if (run.bootstrapUsedAt || !run.bootstrapExpiresAt || run.bootstrapExpiresAt < new Date() || !['CREATING_INFRA', 'SERVER_READY'].includes(run.status)) {
      throw new ConflictException({ code: 'BOOTSTRAP_USED', message: 'El arranque ya se usó o venció' });
    }
    const agentToken = randomBytes(32).toString('base64url');
    // Token aparte, de solo reporte, que sobrevive a la entrega (monitoreo, ADR 052)
    const monitorToken = randomBytes(32).toString('base64url');
    const u = await this.db.system.provisioningRun.updateMany({ where: { id, bootstrapUsedAt: null }, data: { bootstrapUsedAt: new Date(), agentHash: sha(agentToken), monitorHash: sha(monitorToken), agentSeenAt: new Date() } });
    if (u.count !== 1) throw new ConflictException({ code: 'BOOTSTRAP_USED', message: 'El arranque ya se usó o venció' });
    await this.engine.event(id, run.status, 'info', 'El servidor nuevo se comunicó (arranque de un solo uso)', 'agent');
    await this.kick(id);
    const settings = run.settings as { smtp: { host: string; port: number; secure: boolean; user: string; from: string } };
    const img = this.imagesFile();
    return {
      script: agentScript(),
      env: agentEnv({
        API_URL: this.env.API_PUBLIC_URL, RUN_ID: id, AGENT_TOKEN: agentToken, MONITOR_TOKEN: monitorToken, APP_VERSION, APP_DOMAIN: run.domain, ACME_EMAIL: run.adminEmail, PLATFORM_ADMIN_EMAIL: run.adminEmail,
        SMTP_HOST: settings.smtp.host, SMTP_PORT: String(settings.smtp.port), SMTP_SECURE: String(settings.smtp.secure), SMTP_USER: settings.smtp.user,
        SMTP_PASSWORD: this.engine.secrets(run).smtpPassword ?? '', MAIL_FROM: settings.smtp.from, IMAGES_SHA256: img?.sha256 ?? '',
      }),
    };
  }

  private async agent(id: string, authorization: string | undefined) {
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1] ?? '';
    const run = await this.db.system.provisioningRun.findUnique({ where: { id } });
    if (!run || !sameHash(run.agentHash, token)) throw LINK_ERROR();
    return run;
  }

  /** Informe del agente: los pasos que se ejecutan en el servidor nuevo */
  async report(id: string, authorization: string | undefined, input: z.infer<typeof reportSchema>) {
    const run = await this.agent(id, authorization);
    await this.db.system.provisioningRun.update({ where: { id }, data: { agentSeenAt: new Date() } });
    if (!FLOW.includes(run.status)) return { status: run.status, proceed: false };
    const decision = agentReport(run.status, input.step);
    if (decision === 'reject') throw new ConflictException({ code: 'STEP_OUT_OF_ORDER', message: `La instalación está en «${LABEL[run.status]}»` });
    const message = cleanText(input.message);
    const label = `${LABEL[input.step]}${message ? `: ${message}` : ''}`;
    if (decision === 'ignore') return { status: run.status, proceed: true };
    if (input.state === 'failed') {
      const out = { kind: 'stop' as const, error: `Falló «${LABEL[input.step]}» en el servidor${message ? `: ${message}` : ''}`, needs: 'Entra por SSH y revisa /var/log/aisa-instalacion.log; corrige, vuelve a ejecutar /opt/aisa/agente.sh y reintenta.' };
      await this.engine.apply({ ...run, status: run.status }, out);
      return { status: 'NEEDS_INTERVENTION', proceed: false };
    }
    if (input.state !== 'done') {
      await this.engine.event(id, run.status, 'info', label, 'agent');
      return { status: run.status, proceed: true };
    }
    const to = nextOf(input.step);
    await this.engine.apply(run, { kind: 'next', to, message: `${LABEL[input.step]}: listo${message ? ` (${message})` : ''}` });
    await this.kick(id);
    return { status: to, proceed: true };
  }

  /**
   * Reporte periódico de la instalación (cada 10 min, reporte.sh): salud y
   * puesta en marcha, sin datos de clientes. Usa el token de monitoreo, que
   * sigue vigente después de la entrega y se revoca al cancelar.
   */
  async heartbeat(id: string, authorization: string | undefined, input: InstanceReport) {
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1] ?? '';
    const run = await this.db.system.provisioningRun.findUnique({ where: { id }, select: { id: true, status: true, monitorHash: true, lastReport: true, reportAlertedAt: true } });
    if (!run || !sameHash(run.monitorHash, token)) throw LINK_ERROR();
    const before = run.lastReport ? reportSignature(run.lastReport as InstanceReport) : null;
    const recovered = !!run.reportAlertedAt && input.healthy;
    await this.db.system.provisioningRun.update({
      where: { id },
      data: { lastReport: input as Prisma.InputJsonValue, lastReportAt: new Date(), ...(input.healthy ? { reportAlertedAt: null } : {}) },
    });
    if (before !== reportSignature(input)) await this.engine.event(id, run.status, input.healthy ? 'info' : 'warn', `${before ? 'Cambió el estado de la instalación' : 'Primer reporte de la instalación'}: ${reportSummary(input)}`, 'agent');
    else if (recovered) await this.engine.event(id, run.status, 'info', 'La instalación volvió a reportar con servicios sanos', 'agent');
    return { ok: true };
  }

  /** Paquete de entrega (ZIP reproducible, sin secretos) para el agente */
  async package(id: string, authorization: string | undefined) {
    const run = await this.agent(id, authorization);
    const deliveryId = (run.settings as { deliveryId?: string }).deliveryId;
    if (!deliveryId) throw new ConflictException({ code: 'NO_DELIVERY', message: 'La entrega aún no está preparada' });
    return this.deliveries.package(run.createdById, deliveryId);
  }

  /** Imágenes de la versión (las sirve la plataforma; el agente verifica el SHA-256) */
  async images(id: string, authorization: string | undefined) {
    await this.agent(id, authorization);
    const img = this.imagesFile();
    if (!img) throw new NotFoundException({ code: 'NO_IMAGES', message: 'La plataforma no tiene las imágenes de esta versión' });
    return { stream: createReadStream(img.file), ...img };
  }
}
