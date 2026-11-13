import { z } from 'zod';
import { readProfile } from '../ai/ai-profile.js';
import { MODULES } from '../common/decorators/module.decorator.js';
import type { Tx } from '../database/database.service.js';
import { planLimitsSchema } from '../plans/plan-limits.js';
import { subscriptionAccess } from '../plans/subscription-access.js';
import { readSettings } from '../tenants/tenant-settings.js';

export const MODULE_NAME: Record<string, string> = {
  conversations: 'Conversaciones de WhatsApp', ai: 'Asistente IA', catalog: 'Catálogo', inventory: 'Inventario', orders: 'Pedidos',
  customers: 'Clientes', reports: 'Reportes', automations: 'Automatizaciones', reservations: 'Reservas y citas',
};
export const FEATURE_NAME: Record<string, string> = {
  human_handoff: 'Derivación a una persona (bandeja de agentes)', reports: 'Reportes avanzados', advanced_automations: 'Automatizaciones avanzadas',
  advanced_ai: 'IA avanzada', multi_branch: 'Varias sucursales', advanced_roles: 'Roles avanzados',
};
export const MODE_NAME = { SAAS: 'SaaS (en la plataforma central)', DEDICATED: 'Instancia dedicada', CUSTOM: 'Solución a medida' } as const;

/**
 * Contenido del paquete (ADR 044). Es una **foto sin secretos**: ningún token,
 * clave ni contraseña. Las credenciales (WhatsApp, Gemini propia, Chatwoot,
 * webhooks) se vuelven a introducir en la instalación y aparecen como
 * integraciones pendientes.
 */
export const manifestSchema = z.object({
  formatVersion: z.literal(1),
  deliveryId: z.uuid(),
  number: z.number().int().positive(),
  appVersion: z.string(),
  preparedAt: z.string(),
  client: z.object({
    name: z.string(), legalName: z.string().nullable(), taxId: z.string().nullable(), country: z.string(), address: z.string().nullable(),
    phone: z.string().nullable(), contactEmail: z.string().nullable(), currency: z.string(), timezone: z.string(), businessType: z.string(),
    logoUrl: z.string().nullable(), brandColor: z.string().nullable(),
  }),
  system: z.object({ name: z.string(), deploymentMode: z.enum(['SAAS', 'DEDICATED', 'CUSTOM']), domain: z.string().nullable(), panelUrl: z.string() }),
  plan: z.object({ code: z.enum(['BASIC', 'PROFESSIONAL', 'ENTERPRISE']), name: z.string(), limits: planLimitsSchema }),
  subscription: z.object({ state: z.string(), endsAt: z.string() }).nullable(),
  modules: z.array(z.enum(MODULES)).min(1),
  template: z.object({ key: z.string(), version: z.number().nullable() }).nullable(),
  configuration: z.object({
    settings: z.record(z.string(), z.unknown()),
    ai: z.object({ isEnabled: z.boolean(), profile: z.record(z.string(), z.unknown()), monthlyTokenCap: z.number().int().nullable() }),
    knowledge: z.array(z.object({ title: z.string(), content: z.string() })),
    automations: z.array(z.object({ key: z.string(), isEnabled: z.boolean(), config: z.unknown(), version: z.number().int() })),
    categories: z.array(z.object({ name: z.string(), slug: z.string(), description: z.string().nullable(), parent: z.string().nullable() })),
  }),
  integrations: z.array(z.object({ key: z.string(), name: z.string(), status: z.string(), detail: z.string(), pending: z.boolean(), howTo: z.string() })),
  requirements: z.array(z.object({ key: z.string(), label: z.string(), detail: z.string(), required: z.boolean() })),
  initialAccess: z.object({ panelUrl: z.string(), admins: z.array(z.object({ name: z.string(), email: z.string(), status: z.string() })) }),
  support: z.object({ contact: z.string(), notes: z.string().nullable() }),
});
export type DeliveryManifest = z.infer<typeof manifestSchema>;

export interface IntegrationRow { key: string; name: string; status: string; detail: string; howTo: string }

/** Requisitos según la modalidad: lo que el cliente o el técnico deben tener antes de activar */
export function requirementsFor(mode: DeliveryManifest['system']['deploymentMode'], modules: string[], hasPlatformAi: boolean): DeliveryManifest['requirements'] {
  const r: DeliveryManifest['requirements'] = [];
  const own = mode !== 'SAAS';
  if (modules.includes('conversations')) {
    r.push({ key: 'whatsapp', label: 'Número de WhatsApp Business (Cloud API)', required: true, detail: 'Cuenta de Meta Business verificada, una app de Meta con el producto WhatsApp, el número registrado en la Cloud API y un token permanente de usuario del sistema. Ver la guía de conexión de WhatsApp.' });
  }
  if (modules.includes('ai')) {
    r.push({ key: 'gemini', label: 'Clave de la API de Gemini', required: own || !hasPlatformAi, detail: own ? 'Clave de Google AI Studio con facturación activada (en el nivel gratuito Google puede usar los mensajes para mejorar sus productos). Va en GEMINI_API_KEY o, por empresa, en Integraciones.' : 'Opcional: la plataforma ya tiene una clave; la empresa puede usar la suya desde Integraciones.' });
  }
  r.push({ key: 'admin_email', label: 'Correo del administrador', required: true, detail: 'Debe poder recibir la invitación para crear su contraseña (vale 7 días).' });
  if (own) {
    r.push(
      { key: 'server', label: 'Servidor Linux con Docker', required: true, detail: 'x86_64 o arm64, mínimo 2 vCPU, 4 GB de RAM y 20 GB libres (8 GB de RAM si se activa Chatwoot). Docker Engine 24 o superior con Docker Compose 2.20 o superior.' },
      { key: 'domain', label: 'Dominio con DNS apuntando al servidor', required: true, detail: 'Un registro A (o AAAA) del dominio del sistema hacia la IP pública del servidor, con los puertos 80 y 443 abiertos: Caddy obtiene el certificado HTTPS de Let\'s Encrypt automáticamente.' },
      { key: 'smtp', label: 'Cuenta de correo SMTP', required: true, detail: 'Servidor, puerto, usuario y contraseña de un proveedor de correo (Amazon SES, Brevo, Mailgun, Google Workspace…) para invitaciones y avisos.' },
      { key: 'images', label: 'Imágenes de la aplicación', required: true, detail: 'Archivo aisa-imagenes-<versión>.tar.gz entregado junto al paquete (o acceso al repositorio para construirlas). El instalador comprueba que la versión coincide.' },
    );
    if (modules.includes('automations')) r.push({ key: 'n8n', label: 'Automatizaciones por correo (n8n)', required: false, detail: 'Opcional: perfil «automation» del Docker Compose. Sin él, los avisos por correo quedan omitidos y el resto funciona.' });
  }
  return r;
}

/** Foto de la empresa para el paquete. Se ejecuta con el rol de sistema. */
export async function buildManifest(
  tx: Tx,
  tenantId: string,
  d: { id: string; number: number; systemName: string; domain: string | null; supportContact: string; notes: string | null; preparedAt: Date },
  ctx: { appVersion: string; publicUrl: string; graceDays: number; integrations: IntegrationRow[]; hasPlatformAi: boolean },
): Promise<DeliveryManifest> {
  const t = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: {
      subscription: { include: { plan: { select: { code: true, name: true, limits: true } } } },
      users: { where: { role: 'TENANT_ADMIN' }, orderBy: { createdAt: 'asc' }, select: { name: true, email: true, status: true, passwordHash: true } },
    },
  });
  // En serie: una transacción usa una sola conexión
  const ai = await tx.aiSettings.findUnique({ where: { tenantId } });
  const docs = await tx.aiKnowledgeDoc.findMany({ where: { tenantId, publishedContent: { not: null } }, orderBy: { createdAt: 'asc' }, select: { publishedTitle: true, publishedContent: true } });
  const automations = await tx.automation.findMany({ where: { tenantId }, orderBy: { key: 'asc' }, select: { key: true, isEnabled: true, config: true, version: true } });
  const categories = await tx.category.findMany({ where: { tenantId }, orderBy: { name: 'asc' }, select: { name: true, slug: true, description: true, parent: { select: { slug: true } } } });
  if (!t.subscription) throw new Error('La empresa no tiene suscripción');
  const mode = t.deploymentMode;
  const panelUrl = mode === 'SAAS' ? ctx.publicUrl : `https://${d.domain}`;
  const modules = MODULES.filter((m) => t.enabledModules.includes(m));
  const ownInstall = mode !== 'SAAS';
  return {
    formatVersion: 1,
    deliveryId: d.id,
    number: d.number,
    appVersion: ctx.appVersion,
    preparedAt: d.preparedAt.toISOString(),
    client: {
      name: t.name, legalName: t.legalName, taxId: t.taxId, country: t.country, address: t.address, phone: t.phone, contactEmail: t.contactEmail,
      currency: t.currency, timezone: t.timezone, businessType: t.businessType, logoUrl: t.logoUrl, brandColor: t.brandColor,
    },
    system: { name: d.systemName, deploymentMode: mode, domain: ownInstall ? d.domain : null, panelUrl },
    plan: { code: t.subscription.plan.code as 'BASIC' | 'PROFESSIONAL' | 'ENTERPRISE', name: t.subscription.plan.name, limits: planLimitsSchema.parse(t.subscription.plan.limits) },
    subscription: { state: subscriptionAccess(t.subscription, ctx.graceDays, d.preparedAt).state, endsAt: (t.subscription.trialEndsAt && t.subscription.status === 'TRIALING' ? t.subscription.trialEndsAt : t.subscription.currentPeriodEnd).toISOString() },
    modules,
    template: t.templateKey ? { key: t.templateKey, version: t.templateVersion } : null,
    configuration: {
      settings: readSettings(t.settings) as unknown as Record<string, unknown>,
      ai: { isEnabled: ai?.isEnabled ?? true, profile: readProfile(ai?.profile) as unknown as Record<string, unknown>, monthlyTokenCap: ai?.monthlyTokenCap ?? null },
      knowledge: docs.map((x) => ({ title: x.publishedTitle ?? '', content: x.publishedContent ?? '' })),
      automations: automations.map((a) => ({ key: a.key, isEnabled: a.isEnabled, config: a.config, version: a.version })),
      categories: categories.map((c) => ({ name: c.name, slug: c.slug, description: c.description, parent: c.parent?.slug ?? null })),
    },
    // En una instalación propia ninguna credencial viaja: todo lo que depende de una se vuelve a configurar allí
    integrations: ctx.integrations.map((i) => {
      const needsCredentials = ['whatsapp', 'ai', 'chatwoot', 'webhooks'].includes(i.key);
      const pending = ownInstall ? needsCredentials || !['connected', 'managed'].includes(i.status) : !['connected', 'managed'].includes(i.status);
      return { ...i, pending, detail: ownInstall && needsCredentials && i.status !== 'not_configured' ? `${i.detail}. Las credenciales no viajan en el paquete: se vuelven a introducir en la instalación` : i.detail };
    }),
    requirements: requirementsFor(mode, modules, ctx.hasPlatformAi),
    initialAccess: {
      panelUrl,
      admins: t.users.map((u) => ({ name: u.name, email: u.email, status: ownInstall ? 'Recibirá una invitación al instalar' : u.passwordHash ? 'Activo' : 'Invitación pendiente' })),
    },
    support: { contact: d.supportContact, notes: d.notes },
  };
}
