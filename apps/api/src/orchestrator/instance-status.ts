import type { INestApplicationContext } from '@nestjs/common';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { APP_VERSION } from '../deliveries/version.js';
import { IntegrationsStatus } from '../integrations/integrations-status.service.js';
import { computeOnboarding } from '../tenants/onboarding.js';

/** Integraciones que cuentan para la puesta en marcha de una instalación */
export const GO_LIVE_KEYS = ['whatsapp', 'ai', 'email', 'automations'] as const;
const state = z.enum(['connected', 'error', 'not_configured', 'pending', 'managed']);
const text = (max: number) => z.string().max(max);

/**
 * Reporte de una instalación hacia la plataforma central (ADR 052). Solo
 * estados y conteos: ningún dato de clientes, mensajes, pedidos ni credenciales.
 */
export const instanceReportSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  at: z.iso.datetime(),
  healthy: z.boolean(),
  tenants: z.array(z.object({
    name: text(200),
    status: text(40),
    integrations: z.array(z.object({ key: z.enum(GO_LIVE_KEYS), status: state, detail: text(300) }).strict()).max(10),
    /** Lista de puesta en marcha calculada por la instalación (WhatsApp, catálogo, asistente…) */
    tasks: z.array(z.object({ key: z.string().regex(/^[a-z_]{2,40}$/), label: text(200), done: z.boolean(), required: z.boolean() }).strict()).max(20),
    activeProducts: z.number().int().min(0),
    enabledAutomations: z.number().int().min(0),
  }).strict()).max(20),
}).strict();
export type InstanceReport = z.infer<typeof instanceReportSchema>;

/** Lo calcula la propia instalación (node dist/cli.js estado) con sus datos reales */
export async function instanceStatus(app: INestApplicationContext, healthy: boolean): Promise<InstanceReport> {
  const db = app.get(DatabaseService);
  const env = app.get<Env>(ENV);
  const status = app.get(IntegrationsStatus);
  const tenants = await db.system.tenant.findMany({ select: { id: true, name: true, status: true }, orderBy: { createdAt: 'asc' }, take: 20 });
  const out: InstanceReport['tenants'] = [];
  for (const t of tenants) {
    const overview = await status.overview(t.id);
    const [activeProducts, enabledAutomations, onboarding] = await Promise.all([
      db.system.product.count({ where: { tenantId: t.id, status: 'ACTIVE' } }),
      db.system.automation.count({ where: { tenantId: t.id, isEnabled: true } }),
      db.system.$transaction((tx) => computeOnboarding(tx, t.id, { graceDays: env.BILLING_GRACE_DAYS, aiProviderConfigured: !!env.GEMINI_API_KEY, checkInvitations: true })),
    ]);
    out.push({
      name: t.name.slice(0, 200), status: t.status,
      integrations: overview.filter((i) => (GO_LIVE_KEYS as readonly string[]).includes(i.key)).map((i) => ({ key: i.key as (typeof GO_LIVE_KEYS)[number], status: i.status as z.infer<typeof state>, detail: String(i.detail).slice(0, 300) })),
      tasks: onboarding.tasks.slice(0, 20).map((k) => ({ key: k.key, label: k.label.slice(0, 200), done: k.done, required: k.required })),
      activeProducts, enabledAutomations,
    });
  }
  return instanceReportSchema.parse({ version: APP_VERSION, at: new Date().toISOString(), healthy, tenants: out });
}

/** Resumen comparable: si cambia, la plataforma lo deja en el historial */
export function reportSignature(r: InstanceReport) {
  return JSON.stringify([r.version, r.healthy, r.tenants.map((t) => [t.name, t.status, t.integrations.map((i) => `${i.key}:${i.status}`), t.tasks.filter((k) => k.done).map((k) => k.key)])]);
}

const STATE_LABEL: Record<z.infer<typeof state>, string> = { connected: 'conectado', error: 'con error', not_configured: 'sin configurar', pending: 'pendiente', managed: 'gestionado' };
const KEY_LABEL: Record<(typeof GO_LIVE_KEYS)[number], string> = { whatsapp: 'WhatsApp', ai: 'IA', email: 'Correo', automations: 'Automatizaciones' };

/** Texto corto para el historial de la instalación */
export function reportSummary(r: InstanceReport) {
  const parts = r.tenants.map((t) => {
    const req = t.tasks.filter((k) => k.required);
    const ints = t.integrations.map((i) => `${KEY_LABEL[i.key]} ${STATE_LABEL[i.status]}`).join(', ');
    return `${t.name}: ${ints}; puesta en marcha ${req.filter((k) => k.done).length}/${req.length}; ${t.activeProducts} producto(s) activo(s), ${t.enabledAutomations} automatización(es)`;
  });
  return `Versión ${r.version} · ${r.healthy ? 'servicios sanos' : 'hay servicios con problemas'}${parts.length ? ` · ${parts.join(' | ')}` : ' · sin empresas cargadas'}`;
}
