import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { AiRouter } from '../ai/center/ai-router.service.js';
import { runConversation } from '../ai/center/conversation.js';
import type { TranscriptEntry } from '../ai/chat-model.js';
import { COMMERCIAL_TOOLS, commercialSystemPrompt, productFacts, recordRequest, runCommercialTool, upsertInboundLead, type AgentContext } from './agent.js';
import { readCommercial, type CommercialContent, type UpdateCommercialInput } from './settings.js';

/** Mensajes del visitante por conversación del chat web (corta abusos y costo) */
export const CHAT_MAX_MESSAGES = 30;
const HISTORY = 20;

const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s().-]/g, ''))
  .refine((v) => v === '' || /^\+?\d{6,20}$/.test(v), 'Teléfono no válido')
  .transform((v) => v || undefined);

export const publicLeadSchema = z
  .object({
    name: z.string().trim().min(2, 'Escribe tu nombre').max(120),
    company: z.string().trim().max(160).optional().transform((v) => v || undefined),
    phone: phone.optional(),
    email: z.union([z.email('Correo no válido').max(200), z.literal('')]).optional().transform((v) => v?.toLowerCase() || undefined),
    sector: z.enum(['RETAIL', 'RESTAURANT', 'DISTRIBUTOR', 'SERVICES', 'OTHER']).optional(),
    need: z.string().trim().min(5, 'Cuéntanos qué necesitas').max(2000),
    interestPlan: z.enum(['BASIC', 'PROFESSIONAL', 'ENTERPRISE']).optional(),
    interestMode: z.enum(['SAAS', 'DEDICATED', 'CUSTOM']).optional(),
    intent: z.enum(['DEMO', 'PROPOSAL', 'CONTACT']),
    preferredTime: z.string().trim().max(200).optional(),
    /** Uso de los datos para responder esta solicitud */
    acceptPrivacy: z.literal(true, 'Debes aceptar el uso de tus datos para responder la solicitud'),
    /** Contacto posterior (seguimiento): opcional y separado */
    followUpConsent: z.boolean(),
    /** Campo trampa: las personas no lo ven ni lo llenan */
    website: z.string().max(200).optional(),
  })
  .refine((v) => v.phone || v.email, { path: ['phone'], message: 'Deja un teléfono o un correo' });
export type PublicLeadInput = z.infer<typeof publicLeadSchema>;

export const chatMessageSchema = z.object({ token: z.string().min(20).max(100), text: z.string().trim().min(1).max(1000) });
export const agentTestSchema = z.object({ messages: z.array(z.object({ role: z.enum(['customer', 'assistant']), text: z.string().trim().min(1).max(2000) })).min(1).max(20) });

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Página comercial y agente comercial (ADR 048). Toda la información es de la
 * plataforma (rol de sistema); el agente usa la IA asignada al servicio
 * COMMERCIAL de la empresa interna y nunca acepta contratos ni pagos.
 */
@Injectable()
export class CommercialService {
  private readonly log = new Logger('Commercial');
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly router: AiRouter,
  ) {}

  // ---- Panel de la plataforma ----

  async settings() {
    const [content, availability, tenants] = await Promise.all([
      readCommercial(this.db),
      this.availability(),
      this.db.system.tenant.findMany({ where: { status: { in: ['ACTIVE', 'ONBOARDING'] } }, orderBy: { name: 'asc' }, take: 300, select: { id: true, name: true, status: true } }),
    ]);
    return { ...content, agent: availability, tenants };
  }

  async update(userId: string, input: UpdateCommercialInput) {
    if (input.houseTenantId) {
      const t = await this.db.system.tenant.findUnique({ where: { id: input.houseTenantId }, select: { id: true } });
      if (!t) throw new BadRequestException({ code: 'UNKNOWN_TENANT', message: 'La empresa elegida no existe' });
    }
    const before = await readCommercial(this.db);
    const publishing = input.published && !before.published;
    await this.db.system.commercialSettings.update({
      where: { id: 1 },
      data: {
        published: input.published,
        headline: input.headline ?? null,
        subheadline: input.subheadline ?? null,
        problems: input.problems,
        benefits: input.benefits,
        faqs: input.faqs,
        testimonials: input.testimonials,
        contactEmail: input.contactEmail ?? null,
        contactWhatsapp: input.contactWhatsapp ?? null,
        showPrices: input.showPrices,
        chatEnabled: input.chatEnabled,
        agentName: input.agentName ?? null,
        agentInstructions: input.agentInstructions ?? null,
        houseTenantId: input.houseTenantId ?? null,
        updatedById: userId,
        ...(publishing ? { publishedAt: new Date() } : {}),
      },
    });
    const changed = (Object.keys(input) as (keyof UpdateCommercialInput)[]).filter((k) => JSON.stringify(input[k] ?? null) !== JSON.stringify(before[k as keyof CommercialContent] ?? null));
    await this.audit.system({ tenantId: null, userId, action: 'commercial.settings_updated', entityType: 'commercial_settings', metadata: { changed, published: input.published } });
    return this.settings();
  }

  /** ¿Puede responder el agente? (empresa interna con IA asignada al servicio COMMERCIAL) */
  async availability(content?: CommercialContent): Promise<{ available: boolean; reason: string | null; label: string | null }> {
    const c = content ?? (await readCommercial(this.db));
    if (!c.houseTenantId) return { available: false, reason: 'Falta elegir la empresa interna del agente', label: null };
    const r = await this.router.resolve(c.houseTenantId, 'COMMERCIAL');
    if (!r.ok) return { available: false, reason: r.code === 'NOT_CONFIGURED' ? 'La empresa interna no tiene IA asignada al servicio comercial (Centro de APIs)' : `IA no disponible: ${r.reason}`, label: null };
    return { available: true, reason: null, label: r.ai.label };
  }

  async testAgent(messages: z.infer<typeof agentTestSchema>['messages']) {
    const c = await readCommercial(this.db);
    const av = await this.resolveOrThrow(c);
    let handoff: string | null = null;
    const ctx: AgentContext = { channel: 'WEB', leadId: null, phone: null, sessionId: null, conversationId: null, test: true, requestHandoff: (r) => (handoff = r) };
    const r = await runConversation(this.router, av.tenantId, 'COMMERCIAL', av.ai, {
      system: commercialSystemPrompt(c, 'WEB', new Date()),
      transcript: messages.map((m) => ({ role: m.role, text: m.text })),
      tools: COMMERCIAL_TOOLS,
      run: (name, args) => runCommercialTool(this.db, ctx, name, args),
    });
    return { reply: r.text, tools: r.tools, handoff, tokens: r.tokens };
  }

  /** Conversaciones del chat web de un prospecto (para el equipo) */
  async chatsOfLead(leadId: string) {
    const lead = await this.db.system.salesLead.findUnique({ where: { id: leadId }, select: { id: true } });
    if (!lead) throw new NotFoundException('Prospecto no encontrado');
    return this.db.system.salesChatSession.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, createdAt: true, lastMessageAt: true, messageCount: true, handoffAt: true, handoffReason: true, messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { role: true, text: true, tools: true, createdAt: true } } },
    });
  }

  // ---- Público ----

  async publicContent() {
    const c = await readCommercial(this.db);
    if (!c.published) throw new NotFoundException({ code: 'NOT_PUBLISHED', message: 'La página comercial no está publicada' });
    const facts = await productFacts(this.db, c);
    const chat = c.chatEnabled ? (await this.availability(c)).available : false;
    return {
      headline: c.headline,
      subheadline: c.subheadline,
      problems: c.problems,
      benefits: c.benefits,
      testimonials: c.testimonials.map(({ name, company, quote }) => ({ name, company: company ?? null, quote })),
      contact: { email: c.contactEmail, whatsapp: c.contactWhatsapp },
      showPrices: c.showPrices,
      chat: { available: chat, agentName: c.agentName },
      ...facts,
    };
  }

  async submitPublicLead(input: PublicLeadInput, ip: string | null) {
    const c = await readCommercial(this.db);
    if (!c.published) throw new NotFoundException({ code: 'NOT_PUBLISHED', message: 'La página comercial no está publicada' });
    // Bots: se responde igual que a una persona, sin guardar nada
    if (input.website) {
      this.log.warn(`Formulario comercial descartado (campo trampa) desde ${ip ?? '¿?'}`);
      return { ok: true };
    }
    const label = { DEMO: 'demostración', PROPOSAL: 'propuesta', CONTACT: 'contacto' }[input.intent];
    const r = await upsertInboundLead(this.db, {
      name: input.name, company: input.company, phone: input.phone, email: input.email, sector: input.sector, need: input.need,
      interestPlan: input.interestPlan, interestMode: input.interestMode, consent: input.followUpConsent, source: 'WEBSITE',
      note: `Formulario de la página comercial (${label})`, meta: { intent: input.intent },
    });
    await recordRequest(this.db, r.id, input.intent, input.intent === 'DEMO' ? (input.preferredTime ?? '') : input.intent === 'PROPOSAL' ? input.need.slice(0, 500) : '', { by: 'web_form', intent: input.intent });
    return { ok: true };
  }

  async startChat() {
    const c = await readCommercial(this.db);
    if (!c.published || !c.chatEnabled) throw new NotFoundException({ code: 'CHAT_DISABLED', message: 'El chat no está disponible' });
    const av = await this.availability(c);
    if (!av.available) throw new ServiceUnavailableException({ code: 'AGENT_UNAVAILABLE', message: 'El asesor virtual no está disponible ahora. Déjanos tus datos en el formulario y te contactamos.' });
    const token = randomBytes(32).toString('base64url');
    const s = await this.db.system.salesChatSession.create({ data: { tokenHash: sha(token) }, select: { id: true } });
    return { id: s.id, token, maxMessages: CHAT_MAX_MESSAGES, agentName: c.agentName };
  }

  async chat(sessionId: string, token: string, text: string) {
    const s = await this.db.system.salesChatSession.findUnique({ where: { id: sessionId } });
    const given = Buffer.from(sha(token), 'hex');
    if (!s || !timingSafeEqual(Buffer.from(s.tokenHash, 'hex'), given)) throw new UnauthorizedException({ code: 'CHAT_SESSION', message: 'La conversación expiró. Recarga la página para empezar otra.' });
    if (s.createdAt < new Date(Date.now() - 24 * 3_600_000)) throw new UnauthorizedException({ code: 'CHAT_SESSION', message: 'La conversación expiró. Recarga la página para empezar otra.' });
    const c = await readCommercial(this.db);
    if (!c.published || !c.chatEnabled) throw new NotFoundException({ code: 'CHAT_DISABLED', message: 'El chat no está disponible' });
    const av = await this.resolveOrThrow(c);
    // Cupo atómico: dos mensajes simultáneos no superan el límite
    const slot = await this.db.system.salesChatSession.updateMany({ where: { id: s.id, messageCount: { lt: CHAT_MAX_MESSAGES } }, data: { messageCount: { increment: 1 }, lastMessageAt: new Date() } });
    if (slot.count !== 1) throw new ConflictException({ code: 'CHAT_LIMIT', message: 'Llegaste al máximo de mensajes de esta conversación. Déjanos tus datos y un asesor te contacta.' });
    await this.db.system.salesChatMessage.create({ data: { sessionId: s.id, role: 'VISITOR', text } });
    const history = (await this.db.system.salesChatMessage.findMany({ where: { sessionId: s.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: HISTORY, select: { role: true, text: true } })).reverse();
    const transcript: TranscriptEntry[] = history.map((m) => ({ role: m.role === 'VISITOR' ? 'customer' : 'assistant', text: m.text }));
    let handoff: string | null = null;
    const ctx: AgentContext = { channel: 'WEB', leadId: s.leadId, phone: null, sessionId: s.id, conversationId: null, test: false, requestHandoff: (r) => (handoff = r) };
    let reply: string;
    let tools: string[];
    try {
      const r = await runConversation(this.router, av.tenantId, 'COMMERCIAL', av.ai, { system: commercialSystemPrompt(c, 'WEB', new Date()), transcript, tools: COMMERCIAL_TOOLS, run: (name, args) => runCommercialTool(this.db, ctx, name, args) });
      reply = r.text;
      tools = r.tools;
    } catch (e) {
      this.log.error(`Chat comercial ${s.id}: ${(e as Error).message}`);
      throw new ServiceUnavailableException({ code: 'AGENT_UNAVAILABLE', message: 'El asesor virtual no pudo responder. Déjanos tus datos en el formulario y te contactamos.' });
    }
    if (!reply) reply = handoff ? 'Un asesor del equipo continuará contigo por el medio de contacto que dejaste.' : 'No pude responder eso. ¿Quieres que un asesor te contacte?';
    await this.db.system.salesChatMessage.create({ data: { sessionId: s.id, role: 'AGENT', text: reply, tools } });
    if (ctx.leadId && ctx.leadId !== s.leadId) await this.db.system.salesChatSession.update({ where: { id: s.id }, data: { leadId: ctx.leadId } });
    return { reply, handoff: !!handoff, registered: !!ctx.leadId, remaining: Math.max(0, CHAT_MAX_MESSAGES - s.messageCount - 1) };
  }

  private async resolveOrThrow(c: CommercialContent) {
    if (!c.houseTenantId) throw new ServiceUnavailableException({ code: 'AGENT_UNAVAILABLE', message: 'Falta elegir la empresa interna del agente comercial' });
    const r = await this.router.resolve(c.houseTenantId, 'COMMERCIAL');
    if (!r.ok) throw new ServiceUnavailableException({ code: 'AGENT_UNAVAILABLE', message: r.code === 'NOT_CONFIGURED' ? 'La empresa interna no tiene IA asignada al servicio comercial (Centro de APIs)' : `IA no disponible: ${r.reason}` });
    return { tenantId: c.houseTenantId, ai: r.ai };
  }
}
