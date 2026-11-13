import type { INestApplicationContext } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { aiProfileSchema, readProfile } from '../ai/ai-profile.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { AutomationKey } from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import { ProvisioningService } from '../platform/provisioning.service.js';
import { mergeSettings, DEFAULT_SETTINGS, tenantSettingsSchema } from '../tenants/tenant-settings.js';
import { manifestSchema } from './manifest.js';
import { APP_VERSION } from './version.js';

const DAY = 86_400_000;

/** Igualdad de JSON sin depender del orden de las claves (jsonb lo reordena) */
function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, norm(x)])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export interface ImportResult { status: 'created' | 'already_imported'; tenantId: string; tenant: string; admin: string; invitation: { sent: boolean; error?: string } }

/**
 * Carga en una instalación independiente la configuración de la empresa que
 * trae el paquete de entrega (ADR 044). Es idempotente: la clave es el id de
 * la entrega, así que repetir la instalación **no sobrescribe** lo que el
 * cliente haya personalizado después.
 */
export async function importDelivery(app: INestApplicationContext, file: string, opts: { until?: Date } = {}): Promise<ImportResult> {
  const m = manifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (m.system.deploymentMode === 'SAAS') throw new Error('Esta entrega es SaaS: no se instala en un servidor propio');
  if (m.appVersion !== APP_VERSION) throw new Error(`La configuración es de la versión ${m.appVersion} y esta instalación es la ${APP_VERSION}`);
  const db = app.get(DatabaseService);
  const audit = app.get(AuditService);
  const provisioning = app.get(ProvisioningService, { strict: false });

  const actor = await db.system.user.findFirst({ where: { role: 'PLATFORM_ADMIN', status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!actor) throw new Error('No existe el administrador general (lo crea el servicio migrate con PLATFORM_ADMIN_EMAIL)');
  const admin = m.initialAccess.admins[0];
  if (!admin) throw new Error('La entrega no tiene administrador de la empresa');

  const endsAt = opts.until ?? new Date(m.subscription?.endsAt ?? 0);
  if (endsAt.getTime() <= Date.now() + DAY) {
    throw new Error(`El periodo contratado termina el ${endsAt.toISOString().slice(0, 10)}: indica el fin del periodo con --hasta AAAA-MM-DD`);
  }
  if (endsAt.getTime() - Date.now() > 366 * DAY) throw new Error('El periodo inicial no puede pasar de un año: usa --hasta con una fecha anterior');

  // Ya importada: no se toca nada (ni el plan, que el cliente puede haber ajustado después)
  const existing = await db.system.tenant.findUnique({ where: { provisioningKey: m.deliveryId }, select: { id: true, name: true } });
  if (existing) return { status: 'already_imported', tenantId: existing.id, tenant: existing.name, admin: admin.email, invitation: { sent: false } };

  // Funciones contratadas: el plan de esta instalación toma los límites de la entrega
  const plan = await db.system.plan.findUniqueOrThrow({ where: { code: m.plan.code } });
  if (!sameJson(plan.limits, m.plan.limits)) {
    await db.system.plan.update({ where: { id: plan.id }, data: { limits: m.plan.limits as Prisma.InputJsonValue } });
    await audit.system({ tenantId: null, userId: actor.id, action: 'platform.plan_updated', entityType: 'plan', entityId: plan.id, metadata: { before: plan.limits as Prisma.InputJsonValue, after: m.plan.limits as Prisma.InputJsonValue, source: `entrega ${m.deliveryId}` } });
  }

  const c = m.client;
  const r = await provisioning.provision(actor.id, {
    idempotencyKey: m.deliveryId,
    name: c.name, legalName: c.legalName, taxId: c.taxId, country: c.country, currency: c.currency, timezone: c.timezone, address: c.address,
    phone: c.phone, contactEmail: c.contactEmail, businessType: c.businessType as never, logoUrl: c.logoUrl, brandColor: c.brandColor,
    customDomain: m.system.domain, deploymentMode: m.system.deploymentMode, enabledModules: m.modules, templateKey: null,
    planCode: m.plan.code, endsAt, admin: { name: admin.name, email: admin.email.toLowerCase() },
  });
  const tenantId = r.tenant.id;
  if (!r.created) return { status: 'already_imported', tenantId, tenant: r.tenant.name, admin: admin.email, invitation: r.invitation };

  const settings = tenantSettingsSchema.parse(mergeSettings(DEFAULT_SETTINGS, m.configuration.settings));
  const profile = aiProfileSchema.parse(readProfile(m.configuration.ai.profile));
  await db.system.$transaction(async (tx) => {
    await tx.tenant.update({
      where: { id: tenantId },
      data: { settings: settings as unknown as Prisma.InputJsonValue, templateKey: m.template?.key ?? null, templateVersion: m.template?.version ?? null },
    });
    await tx.aiSettings.update({
      where: { tenantId },
      data: { profile: profile as unknown as Prisma.InputJsonValue, draft: Prisma.DbNull, isEnabled: m.configuration.ai.isEnabled, monthlyTokenCap: m.configuration.ai.monthlyTokenCap, publishedAt: new Date(), publishedById: actor.id },
    });
    if (m.configuration.knowledge.length) {
      await tx.aiKnowledgeDoc.createMany({ data: m.configuration.knowledge.map((k) => ({ tenantId, title: k.title, content: k.content, publishedTitle: k.title, publishedContent: k.content, updatedById: actor.id })) });
    }
    for (const a of m.configuration.automations) {
      await tx.automation.updateMany({ where: { tenantId, key: a.key as AutomationKey }, data: { isEnabled: a.isEnabled, config: a.config as Prisma.InputJsonValue, version: a.version, updatedById: actor.id } });
    }
    // Categorías: primero las raíz, después las hijas (por slug)
    const ids = new Map<string, string>();
    for (const cat of [...m.configuration.categories].sort((x, y) => Number(!!x.parent) - Number(!!y.parent))) {
      const row = await tx.category.upsert({
        where: { tenantId_slug: { tenantId, slug: cat.slug } },
        create: { tenantId, name: cat.name, slug: cat.slug, description: cat.description, parentId: cat.parent ? (ids.get(cat.parent) ?? null) : null },
        update: {},
        select: { id: true },
      });
      ids.set(cat.slug, row.id);
    }
  });
  await audit.system({ tenantId, userId: actor.id, action: 'platform.delivery_imported', entityType: 'delivery', entityId: m.deliveryId, metadata: { number: m.number, version: m.appVersion } });
  return { status: 'created', tenantId, tenant: r.tenant.name, admin: admin.email, invitation: r.invitation };
}
