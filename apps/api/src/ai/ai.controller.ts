import { Body, Controller, Get, HttpCode, Inject, Put, Post, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AssistantService } from './assistant.service.js';
import { LlmError } from './chat-model.js';

const settingsSchema = z.object({
  isEnabled: z.boolean(),
  assistantName: z.string().trim().min(1).max(60),
  tone: z.string().trim().min(2).max(120),
  welcomeMessage: z.string().trim().max(500).nullable().optional(),
  businessInfo: z.string().trim().max(6000).nullable().optional(),
  handoffKeywords: z.array(z.string().trim().min(2).max(40)).max(30),
});
const testSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['customer', 'assistant']), text: z.string().trim().min(1).max(2000) })).min(1).max(20),
});

/** Configuración y prueba del asistente de IA de la empresa (FASE 6, ADR 037). */
@RequirePermission('ai:configure')
@Controller('ai')
export class AiController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly assistant: AssistantService,
  ) {}

  @Get('settings')
  async get(@TenantUser() p: TenantPrincipal) {
    const s = await this.db.tenant(p.tenantId, (tx) => tx.aiSettings.upsert({ where: { tenantId: p.tenantId }, create: { tenantId: p.tenantId }, update: {} }));
    return { ...s, provider: { configured: this.assistant.configured, model: this.env.GEMINI_MODEL } };
  }

  @Put('settings')
  update(@TenantUser() p: TenantPrincipal, @Body({ schema: settingsSchema }) b: z.infer<typeof settingsSchema>) {
    const data = { ...b, welcomeMessage: b.welcomeMessage || null, businessInfo: b.businessInfo || null, handoffKeywords: [...new Set(b.handoffKeywords.map((k) => k.toLowerCase()))] };
    return this.db.tenant(p.tenantId, async (tx) => {
      const s = await tx.aiSettings.upsert({ where: { tenantId: p.tenantId }, create: { tenantId: p.tenantId, ...data }, update: data });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'ai.settings_updated', entityType: 'ai_settings', entityId: p.tenantId, metadata: { isEnabled: s.isEnabled } });
      return s;
    });
  }

  /** Conversación de prueba con la configuración guardada; no envía nada por WhatsApp ni crea pedidos. */
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @HttpCode(200)
  @Post('test')
  async test(@TenantUser() p: TenantPrincipal, @Body({ schema: testSchema }) b: z.infer<typeof testSchema>) {
    if (!this.assistant.configured) throw new ServiceUnavailableException({ code: 'AI_NOT_CONFIGURED', message: 'El asistente aún no tiene clave de Gemini configurada en el servidor (GEMINI_API_KEY).' });
    const s = await this.db.tenant(p.tenantId, (tx) => tx.aiSettings.upsert({ where: { tenantId: p.tenantId }, create: { tenantId: p.tenantId }, update: {} }));
    try {
      return await this.assistant.test(p.tenantId, s, b.messages);
    } catch (e) {
      if (e instanceof LlmError) throw new ServiceUnavailableException({ code: 'AI_PROVIDER_ERROR', message: `El modelo de IA no respondió: ${e.message}` });
      throw e;
    }
  }
}
