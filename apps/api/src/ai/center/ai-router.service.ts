import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { LlmError, type ChatSession, type ToolSpec, type TranscriptEntry } from '../chat-model.js';
import { GeminiChatModel } from '../gemini.client.js';
import { AiProviders } from '../providers/registry.js';
import type { AiProviderAdapter, Credentials, GenerationParams } from '../providers/types.js';
import { CredentialVault } from './credential-vault.service.js';
import { ModelCatalog } from './model-catalog.service.js';
import { paramsFor } from './params.js';

export type AiServiceKey = 'ASSISTANT' | 'COMMERCIAL';

interface Target {
  adapter: AiProviderAdapter;
  creds: Credentials;
  model: string;
  credentialId: string | null;
}

/** Proveedor resuelto para una empresa y un servicio (sin secretos fuera del proceso) */
export interface ResolvedAi extends Target {
  provider: string;
  mode: 'MANAGED' | 'OWN' | 'SERVER';
  assignmentId: string | null;
  params: GenerationParams;
  fallback: Target | null;
  /** Texto para el panel, p. ej. «Claude (clave propia) · claude-…» */
  label: string;
}

export type Resolution = { ok: true; ai: ResolvedAi } | { ok: false; reason: string; code: 'NOT_CONFIGURED' | 'DISABLED' | 'CREDENTIAL' | 'LIMIT' };

const BAD = new Set(['AUTH_ERROR', 'PERMISSION_DENIED', 'DISABLED']);
const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

/**
 * Elige proveedor, credencial y modelo de cada llamada (ADR 046):
 *  1. La asignación de la empresa para ese servicio (administrada o propia).
 *  2. Sin asignación, solo el asistente usa la clave de Gemini del servidor (como hasta 0.9.0).
 * Nunca cambia a otro proveedor por su cuenta: el respaldo es otra credencial del
 * mismo proveedor, salvo autorización explícita guardada en la asignación.
 */
@Injectable()
export class AiRouter {
  private readonly log = new Logger(AiRouter.name);
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly providers: AiProviders,
    private readonly vault: CredentialVault,
    private readonly catalog: ModelCatalog,
    private readonly gemini: GeminiChatModel,
  ) {}

  async resolve(tenantId: string, service: AiServiceKey): Promise<Resolution> {
    const a = await this.db.tenant(tenantId, (tx) => tx.aiAssignment.findUnique({ where: { tenantId_service: { tenantId, service } } }));
    if (!a) {
      if (service === 'ASSISTANT' && this.gemini.configured) {
        return { ok: true, ai: { adapter: this.gemini, creds: { secrets: { apiKey: this.env.GEMINI_API_KEY }, config: {} }, model: this.gemini.defaultModel, credentialId: null, provider: 'gemini', mode: 'SERVER', assignmentId: null, params: paramsFor('ECONOMY', null), fallback: null, label: `${this.gemini.name} (clave del servidor) · ${this.gemini.defaultModel}` } };
      }
      return { ok: false, code: 'NOT_CONFIGURED', reason: 'sin proveedor de IA asignado' };
    }
    if (!a.isActive) return { ok: false, code: 'DISABLED', reason: 'la IA de esta empresa está desactivada' };
    const primary = await this.target(tenantId, a.credentialId, a.model);
    if (typeof primary === 'string') return { ok: false, code: 'CREDENTIAL', reason: primary };

    // Topes: el de la asignación (por empresa) y el de la credencial administrada (todas las empresas)
    const since = monthStart();
    if (a.monthlyTokenLimit) {
      const used = await this.db.tenant(tenantId, (tx) => tx.aiUsageEvent.aggregate({ where: { service, createdAt: { gte: since } }, _sum: { inputTokens: true, outputTokens: true } }));
      if ((used._sum.inputTokens ?? 0) + (used._sum.outputTokens ?? 0) >= a.monthlyTokenLimit) return { ok: false, code: 'LIMIT', reason: `tope mensual de la asignación (${a.monthlyTokenLimit} tokens)` };
    }
    if (a.mode === 'MANAGED') {
      const cred = await this.db.system.providerCredential.findUnique({ where: { id: a.credentialId }, select: { monthlyTokenLimit: true } });
      if (cred?.monthlyTokenLimit) {
        const used = await this.db.system.aiUsageEvent.aggregate({ where: { credentialId: a.credentialId, createdAt: { gte: since } }, _sum: { inputTokens: true, outputTokens: true } });
        if ((used._sum.inputTokens ?? 0) + (used._sum.outputTokens ?? 0) >= cred.monthlyTokenLimit) return { ok: false, code: 'LIMIT', reason: 'tope mensual de la credencial administrada' };
      }
    }
    let fallback: Target | null = null;
    if (a.fallbackCredentialId && a.fallbackModel) {
      const f = await this.target(tenantId, a.fallbackCredentialId, a.fallbackModel);
      if (typeof f !== 'string' && (f.adapter.key === primary.adapter.key || a.allowCrossProviderFallback)) fallback = f;
    }
    const who = a.mode === 'OWN' ? 'clave propia' : 'credencial administrada';
    return { ok: true, ai: { ...primary, provider: primary.adapter.key, mode: a.mode, assignmentId: a.id, params: paramsFor(a.profile, a.params), fallback, label: `${primary.adapter.name} (${who}) · ${primary.model}` } };
  }

  /** Credencial utilizable de la empresa o administrada; texto = motivo por el que no se puede usar */
  private async target(tenantId: string, credentialId: string, model: string | null): Promise<Target | string> {
    const c = await this.db.system.providerCredential.findUnique({ where: { id: credentialId } });
    // El disparador de la base ya lo impide; se comprueba otra vez por defensa
    if (!c || (c.tenantId !== null && c.tenantId !== tenantId)) return 'credencial no disponible para esta empresa';
    if (c.disabledAt || BAD.has(c.status)) return `credencial de ${c.label}: ${c.status === 'DISABLED' || c.disabledAt ? 'desconectada' : (c.lastError ?? c.status)}`;
    const adapter = this.providers.get(c.provider);
    if (!adapter) return `proveedor sin adaptador: ${c.provider}`;
    const m = model ?? (c.provider === 'gemini' ? this.gemini.defaultModel : null);
    if (!m) return 'la asignación no tiene modelo';
    return { adapter, creds: this.vault.open(c), model: m, credentialId: c.id };
  }

  /**
   * Abre la conversación con el modelo. Si el primer turno falla por un error
   * temporal y hay respaldo autorizado, se repite con el respaldo.
   */
  async open(ai: ResolvedAi, input: { system: string; transcript: TranscriptEntry[]; tools: ToolSpec[] }) {
    const state = { fallbackUsed: false, target: ai as Target };
    let session: ChatSession = ai.adapter.start(input, { creds: ai.creds, model: ai.model, params: ai.params });
    let first = true;
    const wrapped: ChatSession = {
      next: async () => {
        try {
          return await session.next();
        } catch (e) {
          if (first && ai.fallback && e instanceof LlmError && e.retryable) {
            this.log.warn(`Proveedor principal falló (${e.message}); se usa el respaldo autorizado`);
            state.fallbackUsed = true;
            state.target = ai.fallback;
            session = ai.fallback.adapter.start(input, { creds: ai.fallback.creds, model: ai.fallback.model, params: ai.params });
            return await session.next();
          }
          throw e;
        } finally {
          first = false;
        }
      },
      addToolResults: (r) => session.addToolResults(r),
    };
    return { session: wrapped, state };
  }

  /** Registra el consumo de la llamada con su costo si el modelo tiene precio */
  async record(tenantId: string, service: AiServiceKey, ai: ResolvedAi, state: { fallbackUsed: boolean; target: Target }, r: { input: number; output: number; ok: boolean; error?: string; ms: number }) {
    const t = state.target;
    const price = await this.catalog.costOf(t.adapter.key, t.model, r.input, r.output).catch(() => null);
    await this.db
      .tenant(tenantId, (tx) =>
        tx.aiUsageEvent.create({
          data: {
            tenantId, assignmentId: ai.assignmentId, service, provider: t.adapter.key, model: t.model, credentialId: t.credentialId, mode: ai.mode,
            inputTokens: r.input, outputTokens: r.output, cost: price?.cost ?? null, costCurrency: price?.currency ?? null,
            ok: r.ok, error: r.error?.slice(0, 500) ?? null, latencyMs: Math.round(r.ms), fallbackUsed: state.fallbackUsed,
          },
        }),
      )
      .catch((e: Error) => this.log.warn(`No se pudo registrar el consumo de IA: ${e.message}`));
  }
}
