import { RequireModule } from '../common/decorators/module.decorator.js';
import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { currentPeriod, getPlanLimits } from '../plans/plan-limits.js';
import { AssistantService, KNOWLEDGE_BUDGET, tokenCap } from './assistant.service.js';
import { LlmError } from './chat-model.js';
import { aiProfileSchema, readProfile, type AiProfile } from './ai-profile.js';

const DEFAULT_MAX_DOCS = 5;
const testSchema = z.object({
  target: z.enum(['draft', 'published']).default('draft'),
  messages: z.array(z.object({ role: z.enum(['customer', 'assistant']), text: z.string().trim().min(1).max(2000) })).min(1).max(20),
});
const operationalSchema = z
  .object({ isEnabled: z.boolean().optional(), monthlyTokenCap: z.number().int().min(1000).max(1_000_000_000).nullable().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar');
const docSchema = z.object({ title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(20_000) }).strict();
const uuid = { schema: z.uuid() };

/**
 * Configuración y prueba del asistente de IA de la empresa (ADR 037 y 041).
 * Los cambios se guardan como borrador, se prueban y se publican; el
 * interruptor y el tope de consumo son inmediatos.
 */
@RequirePermission('ai:configure')
@RequireModule('ai')
@Controller('ai')
export class AiController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly assistant: AssistantService,
  ) {}

  @Get('settings')
  get(@TenantUser() p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const s = await settingsOf(tx, p.tenantId);
      const [limits, usage, docChanges] = await Promise.all([
        getPlanLimits(tx),
        tx.usageCounter.findMany({ where: { period: currentPeriod(), metric: { in: ['ai_tokens', 'ai_replies'] } }, select: { metric: true, value: true } }),
        pendingDocChanges(tx),
      ]);
      const used = Object.fromEntries(usage.map((u) => [u.metric, u.value]));
      return {
        isEnabled: s.isEnabled,
        published: readProfile(s.profile),
        draft: s.draft ? readProfile(s.draft) : null,
        hasUnpublishedChanges: !!s.draft || docChanges > 0,
        draftUpdatedAt: s.draftUpdatedAt,
        draftTestedAt: s.draftTestedAt,
        publishedAt: s.publishedAt,
        testRequired: this.assistant.configured,
        monthlyTokenCap: s.monthlyTokenCap,
        usage: { period: currentPeriod(), tokens: used.ai_tokens ?? 0, replies: used.ai_replies ?? 0, planTokenLimit: limits.maxAiTokensPerMonth ?? null, effectiveCap: tokenCap(limits, s.monthlyTokenCap) },
        knowledge: { maxDocs: limits.maxKnowledgeDocs ?? DEFAULT_MAX_DOCS, budgetChars: KNOWLEDGE_BUDGET },
        provider: { configured: this.assistant.configured, model: this.env.GEMINI_MODEL },
      };
    });
  }

  /** Guarda el borrador completo (validado). No cambia lo que ven los clientes. */
  @Put('settings/draft')
  saveDraft(@TenantUser() p: TenantPrincipal, @Body({ schema: aiProfileSchema }) b: AiProfile) {
    const profile: AiProfile = { ...b, handoffKeywords: [...new Set(b.handoffKeywords.map((k) => k.toLowerCase()))] };
    return this.db.tenant(p.tenantId, async (tx) => {
      await settingsOf(tx, p.tenantId);
      const s = await tx.aiSettings.update({ where: { tenantId: p.tenantId }, data: { draft: profile as Prisma.InputJsonValue, draftUpdatedAt: new Date(), draftTestedAt: null } });
      return { draft: readProfile(s.draft), draftUpdatedAt: s.draftUpdatedAt };
    });
  }

  /** Descarta el borrador y los cambios de documentos sin publicar */
  @Delete('settings/draft')
  @HttpCode(204)
  async discard(@TenantUser() p: TenantPrincipal) {
    await this.db.tenant(p.tenantId, async (tx) => {
      await settingsOf(tx, p.tenantId);
      await tx.aiSettings.update({ where: { tenantId: p.tenantId }, data: { draft: Prisma.DbNull, draftUpdatedAt: null, draftTestedAt: null } });
      await tx.aiKnowledgeDoc.deleteMany({ where: { publishedContent: null } });
      await tx.aiKnowledgeDoc.updateMany({ where: { pendingDelete: true }, data: { pendingDelete: false } });
      await tx.$executeRaw`UPDATE ai_knowledge_docs SET title = published_title, content = published_content
        WHERE published_content IS NOT NULL AND (title IS DISTINCT FROM published_title OR content IS DISTINCT FROM published_content)`;
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'ai.draft_discarded', entityType: 'ai_settings', entityId: p.tenantId });
    });
  }

  /** Publica el borrador y los documentos. Con proveedor de IA configurado exige haber probado la versión vigente del borrador. */
  @Post('settings/publish')
  @HttpCode(200)
  publish(@TenantUser() p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const [s] = await tx.$queryRaw<{ draft: unknown; profile: unknown; draft_tested_at: Date | null }[]>`
        SELECT draft, profile, draft_tested_at FROM ai_settings WHERE tenant_id = ${p.tenantId}::uuid FOR UPDATE`;
      if (!s) throw new NotFoundException('Asistente no configurado');
      const docChanges = await pendingDocChanges(tx);
      if (!s.draft && docChanges === 0) throw new ConflictException({ code: 'NOTHING_TO_PUBLISH', message: 'No hay cambios sin publicar' });
      if (this.assistant.configured && !s.draft_tested_at) throw new ConflictException({ code: 'TEST_REQUIRED', message: 'Prueba el borrador al menos una vez antes de publicarlo' });
      const before = readProfile(s.profile);
      const next = s.draft ? readProfile(s.draft) : before;
      await tx.aiKnowledgeDoc.deleteMany({ where: { pendingDelete: true } });
      await tx.$executeRaw`UPDATE ai_knowledge_docs SET published_title = title, published_content = content, updated_at = now()
        WHERE published_content IS DISTINCT FROM content OR published_title IS DISTINCT FROM title`;
      const now = new Date();
      await tx.aiSettings.update({
        where: { tenantId: p.tenantId },
        data: { profile: next as Prisma.InputJsonValue, draft: Prisma.DbNull, draftUpdatedAt: null, draftTestedAt: null, publishedAt: now, publishedById: p.userId },
      });
      const changed = (Object.keys(next) as (keyof AiProfile)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'ai.published', entityType: 'ai_settings', entityId: p.tenantId, metadata: { changed, documents: docChanges } });
      return { publishedAt: now, changed, documents: docChanges };
    });
  }

  /** Interruptor y tope de consumo: efecto inmediato */
  @Patch('settings')
  operational(@TenantUser() p: TenantPrincipal, @Body({ schema: operationalSchema }) b: z.infer<typeof operationalSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      await settingsOf(tx, p.tenantId);
      if (b.monthlyTokenCap) {
        const limits = await getPlanLimits(tx);
        if (limits.maxAiTokensPerMonth && b.monthlyTokenCap > limits.maxAiTokensPerMonth) {
          throw new ForbiddenException({ code: 'PLAN_LIMIT', message: `Tu plan permite como máximo ${limits.maxAiTokensPerMonth} tokens al mes` });
        }
      }
      const s = await tx.aiSettings.update({ where: { tenantId: p.tenantId }, data: b });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'ai.settings_updated', entityType: 'ai_settings', entityId: p.tenantId, metadata: b });
      return { isEnabled: s.isEnabled, monthlyTokenCap: s.monthlyTokenCap };
    });
  }

  // ------------------------------------------------------------ Documentos de conocimiento

  @Get('knowledge')
  docs(@TenantUser() p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const rows = await tx.aiKnowledgeDoc.findMany({ orderBy: { createdAt: 'asc' } });
      return rows.map((d) => ({
        id: d.id, title: d.title, content: d.content, chars: d.content.length, updatedAt: d.updatedAt,
        state: d.pendingDelete ? 'pending_delete' : d.publishedContent === null ? 'new' : d.publishedContent !== d.content || d.publishedTitle !== d.title ? 'modified' : 'published',
      }));
    });
  }

  @Post('knowledge')
  createDoc(@TenantUser() p: TenantPrincipal, @Body({ schema: docSchema }) b: z.infer<typeof docSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const [limits, count] = await Promise.all([getPlanLimits(tx), tx.aiKnowledgeDoc.count({ where: { pendingDelete: false } })]);
      const max = limits.maxKnowledgeDocs ?? DEFAULT_MAX_DOCS;
      if (count >= max) throw new ForbiddenException({ code: 'PLAN_LIMIT_REACHED', message: `Tu plan permite como máximo ${max} documentos para el asistente` });
      const d = await tx.aiKnowledgeDoc.create({ data: { tenantId: p.tenantId, ...b, updatedById: p.userId } });
      await this.touchDraft(tx, p.tenantId);
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'ai.document_created', entityType: 'ai_knowledge_doc', entityId: d.id, metadata: { title: d.title, chars: d.content.length } });
      return { id: d.id, title: d.title, state: 'new' };
    });
  }

  @Put('knowledge/:id')
  updateDoc(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @Body({ schema: docSchema }) b: z.infer<typeof docSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const r = await tx.aiKnowledgeDoc.updateMany({ where: { id, pendingDelete: false }, data: { ...b, updatedById: p.userId } });
      if (!r.count) throw new NotFoundException('Documento no encontrado');
      await this.touchDraft(tx, p.tenantId);
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'ai.document_updated', entityType: 'ai_knowledge_doc', entityId: id, metadata: { title: b.title, chars: b.content.length } });
      return { id };
    });
  }

  /** Un documento sin publicar se borra ya; uno publicado se quita al publicar (hasta entonces sigue vigente). */
  @Delete('knowledge/:id')
  @HttpCode(204)
  async deleteDoc(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    await this.db.tenant(p.tenantId, async (tx) => {
      const d = await tx.aiKnowledgeDoc.findUnique({ where: { id }, select: { publishedContent: true, title: true } });
      if (!d) throw new NotFoundException('Documento no encontrado');
      if (d.publishedContent === null) await tx.aiKnowledgeDoc.delete({ where: { id } });
      else await tx.aiKnowledgeDoc.update({ where: { id }, data: { pendingDelete: true, updatedById: p.userId } });
      await this.touchDraft(tx, p.tenantId);
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'ai.document_deleted', entityType: 'ai_knowledge_doc', entityId: id, metadata: { title: d.title } });
    });
  }

  /** Conversación de prueba; no envía nada por WhatsApp ni crea pedidos. Probar el borrador lo deja listo para publicar. */
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @HttpCode(200)
  @Post('test')
  async test(@TenantUser() p: TenantPrincipal, @Body({ schema: testSchema }) b: z.infer<typeof testSchema>) {
    if (!this.assistant.configured) throw new ServiceUnavailableException({ code: 'AI_NOT_CONFIGURED', message: 'El asistente aún no tiene clave de Gemini configurada en el servidor (GEMINI_API_KEY).' });
    try {
      const r = await this.assistant.test(p.tenantId, b.target, b.messages);
      if (b.target === 'draft' && r.reply) {
        // Solo cuenta como probado si el borrador no cambió mientras respondía
        await this.db.tenant(p.tenantId, (tx) => tx.aiSettings.updateMany({ where: { tenantId: p.tenantId, draftUpdatedAt: r.draftUpdatedAt }, data: { draftTestedAt: new Date() } }));
      }
      return { reply: r.reply, tools: r.tools, handoff: r.handoff, tokens: r.tokens };
    } catch (e) {
      if (e instanceof LlmError) throw new ServiceUnavailableException({ code: 'AI_PROVIDER_ERROR', message: `El modelo de IA no respondió: ${e.message}` });
      throw e;
    }
  }

  /** Un cambio en documentos invalida la prueba anterior: el borrador vuelve a necesitar prueba */
  private async touchDraft(tx: Tx, tenantId: string) {
    await settingsOf(tx, tenantId);
    await tx.aiSettings.update({ where: { tenantId }, data: { draftUpdatedAt: new Date(), draftTestedAt: null } });
  }
}

function settingsOf(tx: Tx, tenantId: string) {
  return tx.aiSettings.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
}

async function pendingDocChanges(tx: Tx): Promise<number> {
  const [r] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ai_knowledge_docs
    WHERE pending_delete OR published_content IS DISTINCT FROM content OR published_title IS DISTINCT FROM title`;
  return r?.n ?? 0;
}
