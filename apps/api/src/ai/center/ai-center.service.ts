import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { LlmError } from '../chat-model.js';
import { AiProviders } from '../providers/registry.js';
import { statusFromHttp } from '../providers/types.js';
import { AiRouter, type AiServiceKey } from './ai-router.service.js';
import { CredentialVault } from './credential-vault.service.js';
import type { CustomParams } from './params.js';

export interface AssignmentInput {
  credentialId: string;
  model: string;
  profile: 'ECONOMY' | 'ADVANCED' | 'CUSTOM';
  params?: CustomParams;
  monthlyTokenLimit?: number | null;
  fallbackCredentialId?: string | null;
  fallbackModel?: string | null;
  allowCrossProviderFallback?: boolean;
}

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

/** Asignaciones de IA por empresa y servicio, prueba real y consumo (ADR 046) */
@Injectable()
export class AiCenter {
  constructor(
    private readonly db: DatabaseService,
    private readonly vault: CredentialVault,
    private readonly providers: AiProviders,
    private readonly router: AiRouter,
    private readonly audit: AuditService,
  ) {}

  /** Comprueba que el modelo existe para esa credencial: catálogo habilitado o, si no está, la lista real del proveedor */
  private async checkModel(provider: string, credentialId: string, ownerTenant: string | null, model: string) {
    const inCatalog = await this.db.system.aiModel.findUnique({ where: { provider_modelId: { provider, modelId: model } }, select: { isEnabled: true } });
    if (inCatalog?.isEnabled) return;
    if (inCatalog && !inCatalog.isEnabled) throw new BadRequestException({ code: 'MODEL_DISABLED', message: `El modelo ${model} está deshabilitado en el catálogo` });
    const cred = await this.vault.get(ownerTenant, credentialId);
    const list = await this.providers.get(provider)!.listModels(this.vault.open(cred)).catch((e: Error) => {
      throw new BadRequestException({ code: 'PROVIDER_ERROR', message: `No se pudo leer la lista de modelos: ${e.message}` });
    });
    if (!list.some((m) => m.id === model)) throw new BadRequestException({ code: 'UNKNOWN_MODEL', message: `${model} no está entre los modelos que el proveedor ofrece a esta credencial` });
  }

  /**
   * Asigna proveedor, credencial y modelo a un servicio de la empresa.
   * `asPlatform`: lo hace el administrador general (puede usar credenciales
   * administradas); si no, la propia empresa (solo sus claves, por RLS).
   */
  async assign(tenantId: string, service: AiServiceKey, userId: string, input: AssignmentInput, asPlatform: boolean) {
    const cred = await this.db.system.providerCredential.findUnique({ where: { id: input.credentialId } });
    if (!cred || (cred.tenantId !== null && cred.tenantId !== tenantId) || (!asPlatform && cred.tenantId !== tenantId)) throw new NotFoundException({ code: 'CREDENTIAL_NOT_FOUND', message: 'Credencial no encontrada' });
    if (cred.disabledAt) throw new BadRequestException({ code: 'CREDENTIAL_DISABLED', message: 'La credencial está desconectada' });
    if (cred.status !== 'CONNECTED' && cred.status !== 'CONNECTED_WITH_WARNINGS') throw new BadRequestException({ code: 'CREDENTIAL_NOT_CONNECTED', message: 'Prueba la credencial antes de asignarla: su última comprobación no fue correcta' });
    const mode = cred.tenantId ? ('OWN' as const) : ('MANAGED' as const);
    await this.checkModel(cred.provider, cred.id, cred.tenantId, input.model);
    if (input.fallbackCredentialId) {
      const f = await this.db.system.providerCredential.findUnique({ where: { id: input.fallbackCredentialId } });
      if (!f || f.tenantId !== cred.tenantId) throw new BadRequestException({ code: 'INVALID_FALLBACK', message: 'El respaldo debe ser otra credencial del mismo dueño' });
      if (f.provider !== cred.provider && !input.allowCrossProviderFallback) throw new BadRequestException({ code: 'CROSS_PROVIDER_FALLBACK', message: 'Un respaldo con otro proveedor envía los datos a otro servicio: requiere autorización explícita' });
      if (!input.fallbackModel) throw new BadRequestException({ code: 'INVALID_FALLBACK', message: 'Indica el modelo del respaldo' });
      await this.checkModel(f.provider, f.id, f.tenantId, input.fallbackModel);
    }
    const data = {
      provider: cred.provider, credentialId: cred.id, mode, model: input.model, profile: input.profile,
      params: input.profile === 'CUSTOM' ? (input.params ?? {}) : {}, monthlyTokenLimit: input.monthlyTokenLimit ?? null,
      fallbackCredentialId: input.fallbackCredentialId ?? null, fallbackModel: input.fallbackCredentialId ? (input.fallbackModel ?? null) : null,
      allowCrossProviderFallback: !!input.fallbackCredentialId && !!input.allowCrossProviderFallback, isActive: true, assignedById: userId,
    };
    const write = async (tx: Parameters<Parameters<DatabaseService['tenant']>[1]>[0]) => {
      const before = await tx.aiAssignment.findUnique({ where: { tenantId_service: { tenantId, service } }, select: { provider: true, model: true, mode: true } });
      const a = await tx.aiAssignment.upsert({ where: { tenantId_service: { tenantId, service } }, create: { tenantId, service, ...data }, update: data });
      await this.audit.inTx(tx, { tenantId, userId, action: 'api_center.assignment_set', entityType: 'ai_assignment', entityId: a.id, metadata: { service, before, after: { provider: a.provider, model: a.model, mode: a.mode, profile: a.profile }, crossProviderFallback: a.allowCrossProviderFallback } });
      return a;
    };
    return asPlatform ? this.db.system.$transaction(write) : this.db.tenant(tenantId, write);
  }

  async setActive(tenantId: string, service: AiServiceKey, userId: string, isActive: boolean) {
    return this.db.system.$transaction(async (tx) => {
      const a = await tx.aiAssignment.findUnique({ where: { tenantId_service: { tenantId, service } } });
      if (!a) throw new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'La empresa no tiene asignación para ese servicio' });
      if (isActive) {
        const c = await tx.providerCredential.findUnique({ where: { id: a.credentialId }, select: { disabledAt: true } });
        if (c?.disabledAt) throw new BadRequestException({ code: 'CREDENTIAL_DISABLED', message: 'La credencial asignada está desconectada: asigna otra' });
      }
      const r = await tx.aiAssignment.update({ where: { id: a.id }, data: { isActive } });
      await this.audit.inTx(tx, { tenantId, userId, action: isActive ? 'api_center.assignment_enabled' : 'api_center.assignment_disabled', entityType: 'ai_assignment', entityId: a.id, metadata: { service } });
      return r;
    });
  }

  /** Quita la asignación. La empresa solo puede quitar la de su clave propia (RLS) */
  async unassign(tenantId: string, service: AiServiceKey, userId: string, asPlatform: boolean) {
    const del = async (tx: Parameters<Parameters<DatabaseService['tenant']>[1]>[0]) => {
      const a = await tx.aiAssignment.findUnique({ where: { tenantId_service: { tenantId, service } } });
      if (!a) throw new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'La empresa no tiene asignación para ese servicio' });
      const n = await tx.aiAssignment.deleteMany({ where: { id: a.id } });
      if (!n.count) throw new BadRequestException({ code: 'MANAGED_ASSIGNMENT', message: 'Esta asignación la gestiona la plataforma' });
      await this.audit.inTx(tx, { tenantId, userId, action: 'api_center.assignment_removed', entityType: 'ai_assignment', entityId: a.id, metadata: { service, provider: a.provider, model: a.model, mode: a.mode } });
    };
    await (asPlatform ? this.db.system.$transaction(del) : this.db.tenant(tenantId, del));
  }

  /**
   * Prueba real de la asignación: una petición de generación muy corta al
   * modelo asignado (consume unos pocos tokens y queda en el consumo).
   */
  async testAssignment(tenantId: string, service: AiServiceKey, userId: string | null) {
    const r = await this.router.resolve(tenantId, service);
    if (!r.ok) return { ok: false, detail: `No se puede usar: ${r.reason}`, ms: 0 };
    const t = Date.now();
    const { session, state } = await this.router.open({ ...r.ai, params: { maxOutputTokens: 256 } }, { system: 'Prueba de conexión de AI Sales Assistant. Responde exactamente con la palabra OK.', transcript: [{ role: 'customer', text: 'Responde solo: OK' }], tools: [] });
    try {
      const turn = await session.next();
      const ms = Date.now() - t;
      await this.router.record(tenantId, service, r.ai, state, { input: turn.usage.input, output: turn.usage.output, ok: true, ms });
      const detail = `${r.ai.label}: respondió «${turn.text.slice(0, 80) || '(sin texto)'}» en ${ms} ms (${turn.usage.input + turn.usage.output} tokens)${state.fallbackUsed ? ' usando el respaldo' : ''}`;
      await this.recordCheck(tenantId, r.ai.provider, true, ms, detail, userId);
      return { ok: true, detail, ms, reply: turn.text, provider: state.target.adapter.key, model: state.target.model, fallbackUsed: state.fallbackUsed, tokens: turn.usage.input + turn.usage.output };
    } catch (e) {
      const ms = Date.now() - t;
      const msg = (e as Error).message;
      await this.router.record(tenantId, service, r.ai, state, { input: 0, output: 0, ok: false, error: msg, ms });
      // Un rechazo de autenticación o de permisos se refleja en el estado de la credencial
      if (e instanceof LlmError && (e.status === 401 || e.status === 403) && r.ai.credentialId) {
        await this.db.system.providerCredential.update({ where: { id: r.ai.credentialId }, data: { status: statusFromHttp(e.status), lastError: msg.slice(0, 500), lastCheckedAt: new Date() } });
      }
      await this.recordCheck(tenantId, r.ai.provider, false, ms, `${r.ai.label}: ${msg}`, userId);
      return { ok: false, detail: `${r.ai.label}: ${msg}`, ms };
    }
  }

  private recordCheck(tenantId: string, provider: string, ok: boolean, ms: number, detail: string, userId: string | null) {
    return this.db.tenant(tenantId, (tx) => tx.integrationCheck.create({ data: { tenantId, service: 'ai', ok, latencyMs: Math.round(ms), detail: `[${provider}] ${detail}`.slice(0, 500), checkedById: userId } }));
  }

  /** Consumo del mes por proveedor y modelo (costo solo si hay precio) */
  async usage(tenantId: string | null) {
    const since = monthStart();
    const where = { createdAt: { gte: since }, ...(tenantId ? { tenantId } : {}) };
    const rows = await (tenantId
      ? this.db.tenant(tenantId, (tx) => tx.aiUsageEvent.groupBy({ by: ['provider', 'model', 'mode', 'service', 'costCurrency'], where, _sum: { inputTokens: true, outputTokens: true, cost: true }, _count: { _all: true } }))
      : this.db.system.aiUsageEvent.groupBy({ by: ['tenantId', 'provider', 'model', 'mode', 'service', 'costCurrency'], where, _sum: { inputTokens: true, outputTokens: true, cost: true }, _count: { _all: true } }));
    const errors = tenantId
      ? await this.db.tenant(tenantId, (tx) => tx.aiUsageEvent.count({ where: { ...where, ok: false } }))
      : await this.db.system.aiUsageEvent.count({ where: { ...where, ok: false } });
    const unpriced = tenantId
      ? await this.db.tenant(tenantId, (tx) => tx.aiUsageEvent.count({ where: { ...where, ok: true, cost: null } }))
      : await this.db.system.aiUsageEvent.count({ where: { ...where, ok: true, cost: null } });
    return {
      since,
      errors,
      /** Llamadas sin precio en el catálogo: el costo total es incompleto si > 0 */
      unpricedCalls: unpriced,
      rows: rows.map((r) => ({
        ...('tenantId' in r ? { tenantId: r.tenantId as string } : {}),
        provider: r.provider, model: r.model, mode: r.mode, service: r.service, calls: r._count._all,
        inputTokens: r._sum.inputTokens ?? 0, outputTokens: r._sum.outputTokens ?? 0, cost: r._sum.cost?.toString() ?? null, costCurrency: r.costCurrency,
      })),
    };
  }
}
