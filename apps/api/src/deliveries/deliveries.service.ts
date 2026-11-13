import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { IntegrationsStatus } from '../integrations/integrations-status.service.js';
import { renderDocs } from './docs.js';
import { kitEntries } from './kit.js';
import { buildManifest, manifestSchema, type DeliveryManifest } from './manifest.js';
import { APP_VERSION } from './version.js';
import { zip, type ZipEntry } from './zip.js';

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Dominio no válido (p. ej. ventas.miempresa.pe)');

export const createDeliverySchema = z
  .object({
    systemName: z.string().trim().min(2).max(120),
    domain: hostname.nullish(),
    supportContact: z.string().trim().min(5).max(300),
    notes: z.string().trim().max(2000).nullish(),
  })
  .strict();
export type CreateDeliveryInput = z.infer<typeof createDeliverySchema>;

export const deliverySelect = {
  id: true, tenantId: true, number: true, systemName: true, deploymentMode: true, appVersion: true, domain: true, supportContact: true, notes: true,
  status: true, packageSha256: true, packageBytes: true, generatedAt: true, deliveredAt: true, createdAt: true,
} as const;

/**
 * Entrega de sistemas (ADR 044). La plataforma prepara una entrega (foto de la
 * empresa sin secretos), revisa requisitos e integraciones pendientes y genera
 * un ZIP **reproducible**: las mismas entradas y la misma versión producen los
 * mismos bytes, verificables con la huella SHA-256 guardada.
 */
@Injectable()
export class DeliveriesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationsStatus,
    @Inject(ENV) private readonly env: Env,
  ) {}

  list(tenantId: string) {
    return this.db.system.delivery.findMany({ where: { tenantId }, orderBy: { number: 'desc' }, select: deliverySelect });
  }

  async get(id: string) {
    const d = await this.db.system.delivery.findUnique({ where: { id }, select: { ...deliverySelect, manifest: true } });
    if (!d) throw new NotFoundException('Entrega no encontrada');
    return d;
  }

  private async snapshot(tenantId: string, d: { id: string; number: number; systemName: string; domain: string | null; supportContact: string; notes: string | null; preparedAt: Date }) {
    const integrations = (await this.integrations.overview(tenantId)).map((i) => ({ key: i.key, name: i.name, status: i.status, detail: i.detail, howTo: i.howTo }));
    return this.db.system.$transaction((tx) =>
      buildManifest(tx, tenantId, d, { appVersion: APP_VERSION, publicUrl: this.env.APP_PUBLIC_URL, graceDays: this.env.BILLING_GRACE_DAYS, integrations, hasPlatformAi: !!this.env.GEMINI_API_KEY }),
    );
  }

  private validate(mode: string, input: { domain?: string | null }) {
    if (mode !== 'SAAS' && !input.domain) throw new BadRequestException({ code: 'DOMAIN_REQUIRED', message: 'Una instalación independiente necesita el dominio del sistema', errors: [{ path: 'domain', message: 'Indica el dominio' }] });
    if (mode === 'SAAS' && input.domain) throw new BadRequestException({ code: 'DOMAIN_NOT_ALLOWED', message: 'En SaaS el sistema usa el dominio de la plataforma', errors: [{ path: 'domain', message: 'Déjalo vacío en SaaS' }] });
  }

  async create(actorId: string, tenantId: string, input: CreateDeliveryInput) {
    const t = await this.db.system.tenant.findUnique({ where: { id: tenantId }, select: { deploymentMode: true, subscription: { select: { id: true } } } });
    if (!t) throw new NotFoundException('Empresa no encontrada');
    if (!t.subscription) throw new ConflictException('La empresa no tiene un plan asignado');
    this.validate(t.deploymentMode, input);
    const id = randomUUID();
    const [counter] = await this.db.system.$queryRaw<{ value: number }[]>`
      INSERT INTO tenant_counters (tenant_id, key, value) VALUES (${tenantId}::uuid, 'delivery_number', 1)
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = tenant_counters.value + 1
      RETURNING value`;
    const base = { id, number: counter!.value, systemName: input.systemName, domain: input.domain ?? null, supportContact: input.supportContact, notes: input.notes ?? null, preparedAt: new Date() };
    const manifest = await this.snapshot(tenantId, base);
    const d = await this.db.system.delivery.create({
      data: {
        id, tenantId, number: base.number, systemName: base.systemName, deploymentMode: t.deploymentMode, appVersion: APP_VERSION, domain: base.domain,
        supportContact: base.supportContact, notes: base.notes, manifest: manifest as unknown as Prisma.InputJsonValue, createdById: actorId, createdAt: base.preparedAt,
      },
      select: { ...deliverySelect, manifest: true },
    });
    await this.audit.system({ tenantId, userId: actorId, action: 'platform.delivery_prepared', entityType: 'delivery', entityId: id, metadata: { number: d.number, mode: d.deploymentMode, version: APP_VERSION } });
    return d;
  }

  /** Vuelve a tomar la foto (p. ej. tras conectar WhatsApp). Solo mientras no haya paquete generado. */
  async refresh(actorId: string, id: string) {
    const d = await this.get(id);
    if (d.status !== 'DRAFT') throw new ConflictException({ code: 'DELIVERY_FROZEN', message: 'El paquete ya se generó y no cambia (es reproducible). Prepara una entrega nueva para incluir cambios.' });
    const t = await this.db.system.tenant.findUniqueOrThrow({ where: { id: d.tenantId }, select: { deploymentMode: true } });
    this.validate(t.deploymentMode, d);
    const preparedAt = new Date();
    const manifest = await this.snapshot(d.tenantId, { ...d, preparedAt });
    await this.db.system.delivery.update({ where: { id }, data: { manifest: manifest as unknown as Prisma.InputJsonValue, deploymentMode: t.deploymentMode, appVersion: APP_VERSION, createdAt: preparedAt } });
    await this.audit.system({ tenantId: d.tenantId, userId: actorId, action: 'platform.delivery_refreshed', entityType: 'delivery', entityId: id });
    return this.get(id);
  }

  /** Archivos del paquete a partir del manifiesto guardado */
  entries(m: DeliveryManifest): ZipEntry[] {
    const files: ZipEntry[] = [...renderDocs(m), { path: 'entrega.json', data: `${JSON.stringify(m, null, 2)}\n` }];
    if (m.system.deploymentMode !== 'SAAS') files.push(...kitEntries(m));
    this.assertNoSecrets(files);
    const sums = [...files]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => `${createHash('sha256').update(f.data).digest('hex')}  ${f.path}`)
      .join('\n');
    return [...files, { path: 'SHA256SUMS', data: `${sums}\n` }];
  }

  /**
   * Red de seguridad: ningún secreto del servidor puede acabar en el ZIP. Las
   * credenciales de las empresas ni siquiera se leen al preparar la entrega.
   */
  private assertNoSecrets(files: ZipEntry[]) {
    const e = this.env;
    const secrets = [
      e.JWT_SECRET, e.DATA_ENCRYPTION_KEY, e.APP_DB_RUNTIME_PASSWORD, e.APP_DB_SYSTEM_PASSWORD, e.REDIS_PASSWORD, e.SMTP_PASSWORD,
      e.GEMINI_API_KEY, e.WHATSAPP_APP_SECRET, e.N8N_INTERNAL_TOKEN, e.CHATWOOT_PLATFORM_TOKEN,
    ].filter((s): s is string => typeof s === 'string' && s.length >= 8);
    for (const f of files) {
      const text = typeof f.data === 'string' ? f.data : f.data.toString('utf8');
      if (secrets.some((s) => text.includes(s))) throw new Error(`El archivo ${f.path} contiene un secreto del servidor: no se genera el paquete`);
    }
  }

  async package(actorId: string, id: string) {
    const d = await this.get(id);
    const m = manifestSchema.parse(d.manifest);
    if (m.appVersion !== APP_VERSION) {
      throw new ConflictException({ code: 'VERSION_CHANGED', message: `Esta entrega se preparó con la versión ${m.appVersion} y el sistema está en la ${APP_VERSION}. Prepara una entrega nueva.` });
    }
    const buf = zip(this.entries(m));
    const sha = createHash('sha256').update(buf).digest('hex');
    if (d.status === 'DRAFT') {
      await this.db.system.delivery.update({ where: { id }, data: { status: 'GENERATED', packageSha256: sha, packageBytes: buf.length, generatedAt: new Date() } });
      await this.audit.system({ tenantId: d.tenantId, userId: actorId, action: 'platform.delivery_generated', entityType: 'delivery', entityId: id, metadata: { sha256: sha, bytes: buf.length, version: APP_VERSION } });
    } else if (d.packageSha256 !== sha) {
      // No debería pasar: mismo manifiesto y misma versión. Se informa en lugar de entregar otro contenido.
      throw new ConflictException({ code: 'NOT_REPRODUCIBLE', message: 'El paquete regenerado no coincide con la huella guardada. Prepara una entrega nueva.' });
    }
    const slug = await this.db.system.tenant.findUniqueOrThrow({ where: { id: d.tenantId }, select: { slug: true } });
    return { buffer: buf, sha256: sha, filename: `entrega-${slug.slug}-${d.number}-v${m.appVersion}.zip` };
  }

  async markDelivered(actorId: string, id: string) {
    const d = await this.get(id);
    if (d.status === 'DRAFT') throw new ConflictException({ code: 'NOT_GENERATED', message: 'Genera y descarga el paquete antes de marcarlo como entregado' });
    if (d.status === 'DELIVERED') return d;
    await this.db.system.delivery.update({ where: { id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    await this.audit.system({ tenantId: d.tenantId, userId: actorId, action: 'platform.delivery_delivered', entityType: 'delivery', entityId: id });
    return this.get(id);
  }
}
