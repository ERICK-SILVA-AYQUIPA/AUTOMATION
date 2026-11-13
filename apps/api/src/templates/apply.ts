import { readProfile, type AiProfile } from '../ai/ai-profile.js';
import { catalogEntry } from '../automations/catalog.js';
import type { Tx } from '../database/database.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AutomationKey } from '../generated/prisma/enums.js';
import { planLimitsSchema } from '../plans/plan-limits.js';
import { slugify } from '../tenants/tenant-bootstrap.js';
import { mergeSettings, readSettings, tenantSettingsSchema } from '../tenants/tenant-settings.js';
import { TEMPLATES, type TemplateKey, type TemplateSection } from './catalog.js';

export interface TemplateChange { section: TemplateSection; field: string; from: unknown; to: unknown; note?: string }
export interface TemplatePlan {
  template: { key: TemplateKey; version: number; name: string };
  current: { key: string | null; version: number | null };
  changes: TemplateChange[];
  /** Lo que no se aplicará y por qué (plan, módulo apagado) */
  blocked: TemplateChange[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Qué cambiaría al aplicar la plantilla. Se calcula con el estado real de la
 * empresa, así la plataforma ve exactamente qué se sobrescribe antes de
 * aplicarla. Debe ejecutarse con el rol de sistema.
 */
export async function planTemplate(tx: Tx, tenantId: string, key: TemplateKey): Promise<TemplatePlan> {
  const tpl = TEMPLATES[key];
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { enabledModules: true, settings: true, businessType: true, templateKey: true, templateVersion: true, subscription: { select: { plan: { select: { limits: true } } } } },
  });
  const [automations, ai, categories] = await Promise.all([
    tx.automation.findMany({ where: { tenantId }, select: { key: true, isEnabled: true } }),
    tx.aiSettings.findUnique({ where: { tenantId }, select: { profile: true, draft: true } }),
    tx.category.findMany({ where: { tenantId }, select: { slug: true } }),
  ]);
  const changes: TemplateChange[] = [];
  const blocked: TemplateChange[] = [];

  const modules = [...tpl.modules].sort();
  const currentModules = [...tenant.enabledModules].sort();
  if (!same(modules, currentModules)) changes.push({ section: 'modules', field: 'enabledModules', from: currentModules, to: modules });

  if (tenant.businessType !== tpl.businessType) changes.push({ section: 'settings', field: 'businessType', from: tenant.businessType, to: tpl.businessType });
  const settings = readSettings(tenant.settings);
  for (const [section, values] of Object.entries(tpl.settings)) {
    for (const [field, to] of Object.entries(values ?? {})) {
      const from = (settings as unknown as Record<string, Record<string, unknown>>)[section]?.[field];
      if (!same(from, to)) changes.push({ section: 'settings', field: `${section}.${field}`, from, to });
    }
  }

  const features = planLimitsSchema.safeParse(tenant.subscription?.plan.limits).data?.features ?? [];
  for (const [k, to] of Object.entries(tpl.automations) as [AutomationKey, boolean][]) {
    const row = automations.find((a) => a.key === k);
    const entry = catalogEntry(k);
    if (!row || !entry || row.isEnabled === to) continue;
    const change: TemplateChange = { section: 'automations', field: k, from: row.isEnabled, to };
    if (to && entry.feature && !features.includes(entry.feature)) blocked.push({ ...change, note: 'El plan de la empresa no la incluye' });
    else if (to && !tpl.modules.includes(entry.module)) blocked.push({ ...change, note: `Requiere el módulo ${entry.module}` });
    else changes.push(change);
  }

  // El asistente: se compara con lo que la empresa ve (borrador si existe)
  const profile = readProfile(ai?.draft ?? ai?.profile);
  for (const [field, to] of Object.entries(tpl.ai) as [keyof AiProfile, unknown][]) {
    if (!same(profile[field], to)) changes.push({ section: 'ai', field, from: profile[field], to });
  }

  const existing = new Set(categories.map((c) => c.slug));
  for (const name of tpl.categories) if (!existing.has(slugify(name))) changes.push({ section: 'categories', field: name, from: null, to: name });

  return { template: { key, version: tpl.version, name: tpl.name }, current: { key: tenant.templateKey, version: tenant.templateVersion }, changes, blocked };
}

/**
 * Aplica solo las secciones elegidas. Lo del asistente va al borrador (la
 * empresa lo prueba y publica), salvo en el alta (`aiTarget: 'published'`),
 * donde no hay nada personalizado que pisar.
 */
export async function applyTemplate(tx: Tx, tenantId: string, key: TemplateKey, sections: TemplateSection[], opts: { aiTarget: 'draft' | 'published' }) {
  const tpl = TEMPLATES[key];
  const plan = await planTemplate(tx, tenantId, key);
  const applied = plan.changes.filter((c) => sections.includes(c.section));
  const has = (s: TemplateSection) => applied.some((c) => c.section === s);

  const tenantData: Prisma.TenantUpdateInput = { templateKey: key, templateVersion: tpl.version };
  if (has('modules')) tenantData.enabledModules = [...tpl.modules];
  if (has('settings')) {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
    const merged = tenantSettingsSchema.parse(mergeSettings(readSettings(t.settings), tpl.settings));
    tenantData.settings = merged as unknown as Prisma.InputJsonValue;
    tenantData.businessType = tpl.businessType;
  }
  await tx.tenant.update({ where: { id: tenantId }, data: tenantData });

  for (const c of applied.filter((x) => x.section === 'automations')) {
    await tx.automation.update({ where: { tenantId_key: { tenantId, key: c.field as AutomationKey } }, data: { isEnabled: c.to as boolean } });
  }

  if (has('ai')) {
    const s = await tx.aiSettings.findUniqueOrThrow({ where: { tenantId }, select: { profile: true, draft: true } });
    const fields = Object.fromEntries(applied.filter((c) => c.section === 'ai').map((c) => [c.field, c.to]));
    if (opts.aiTarget === 'published') {
      await tx.aiSettings.update({ where: { tenantId }, data: { profile: { ...readProfile(s.profile), ...fields } as Prisma.InputJsonValue } });
    } else {
      await tx.aiSettings.update({ where: { tenantId }, data: { draft: { ...readProfile(s.draft ?? s.profile), ...fields } as Prisma.InputJsonValue, draftUpdatedAt: new Date(), draftTestedAt: null } });
    }
  }

  for (const c of applied.filter((x) => x.section === 'categories')) {
    await tx.category.create({ data: { tenantId, name: c.field, slug: slugify(c.field) } });
  }
  return { ...plan, applied };
}
