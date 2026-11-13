import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AiCenter } from '../ai/center/ai-center.service.js';
import { AiRouter } from '../ai/center/ai-router.service.js';
import { CredentialVault } from '../ai/center/credential-vault.service.js';
import { customParamsSchema } from '../ai/center/params.js';
import { AiProviders } from '../ai/providers/registry.js';
import { STATUS_LABEL } from '../ai/providers/types.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';

export const credentialBody = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    label: z.string().trim().max(80).optional(),
    fields: z.record(z.string(), z.string().max(500)),
  })
  .strict();
export const rotateBody = z.object({ fields: z.record(z.string(), z.string().max(500)) }).strict();
export const assignmentBody = z
  .object({
    credentialId: z.uuid(),
    model: z.string().trim().min(1).max(120),
    profile: z.enum(['ECONOMY', 'ADVANCED', 'CUSTOM']).default('ECONOMY'),
    params: customParamsSchema.optional(),
    monthlyTokenLimit: z.number().int().positive().max(1_000_000_000).nullable().optional(),
    fallbackCredentialId: z.uuid().nullable().optional(),
    fallbackModel: z.string().trim().min(1).max(120).nullable().optional(),
    allowCrossProviderFallback: z.boolean().optional(),
  })
  .strict();
const idParam = { schema: z.uuid() };

/** Ficha pública de cada proveedor con adaptador (campos que pide el formulario) */
export function providerCards(providers: AiProviders) {
  return providers.list().map((a) => ({ key: a.key, name: a.name, fields: a.fields.map((f) => ({ key: f.key, label: f.label, secret: f.secret, required: f.required, hint: f.hint ?? null })) }));
}

/**
 * IA de la empresa en el Centro de APIs (ADR 046): sus claves propias (cifradas,
 * validadas con el proveedor), el modelo que usa su asistente, la prueba real y
 * el consumo. Las credenciales administradas por la plataforma no se ven aquí;
 * solo cuál tiene asignada.
 */
@RequirePermission('integrations:manage')
@Controller('integrations/ai')
export class AiIntegrationsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly vault: CredentialVault,
    private readonly center: AiCenter,
    private readonly providers: AiProviders,
    private readonly router: AiRouter,
  ) {}

  @Get()
  async overview(@TenantUser() p: TenantPrincipal) {
    const [credentials, assignment, usage] = await Promise.all([
      this.vault.list(p.tenantId),
      this.db.tenant(p.tenantId, (tx) => tx.aiAssignment.findUnique({ where: { tenantId_service: { tenantId: p.tenantId, service: 'ASSISTANT' } } })),
      this.center.usage(p.tenantId),
    ]);
    // De una credencial administrada la empresa solo ve el proveedor y sus últimos caracteres
    const managed = assignment?.mode === 'MANAGED' ? await this.db.system.providerCredential.findUnique({ where: { id: assignment.credentialId }, select: { label: true, status: true, secretHint: true } }) : null;
    const resolved = await this.router.resolve(p.tenantId, 'ASSISTANT');
    return {
      providers: providerCards(this.providers),
      statusLabels: STATUS_LABEL,
      credentials,
      assignment: assignment && {
        id: assignment.id, provider: assignment.provider, mode: assignment.mode, model: assignment.model, profile: assignment.profile, params: assignment.params,
        monthlyTokenLimit: assignment.monthlyTokenLimit, isActive: assignment.isActive, credentialId: assignment.mode === 'OWN' ? assignment.credentialId : null,
        managedCredential: managed, hasFallback: !!assignment.fallbackCredentialId, allowCrossProviderFallback: assignment.allowCrossProviderFallback, updatedAt: assignment.updatedAt,
      },
      effective: resolved.ok ? { label: resolved.ai.label, provider: resolved.ai.provider, model: resolved.ai.model, mode: resolved.ai.mode } : { label: null, reason: resolved.reason, code: resolved.code },
      usage,
    };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('credentials')
  create(@TenantUser() p: TenantPrincipal, @Body({ schema: credentialBody }) b: z.infer<typeof credentialBody>) {
    return this.vault.create(p.tenantId, p.userId, b);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('credentials/:id/rotate')
  rotate(@TenantUser() p: TenantPrincipal, @Param('id', idParam) id: string, @Body({ schema: rotateBody }) b: z.infer<typeof rotateBody>) {
    return this.vault.rotate(p.tenantId, p.userId, id, b.fields);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('credentials/:id/test')
  test(@TenantUser() p: TenantPrincipal, @Param('id', idParam) id: string) {
    return this.vault.test(p.tenantId, p.userId, id);
  }

  @HttpCode(200)
  @Post('credentials/:id/disable')
  disable(@TenantUser() p: TenantPrincipal, @Param('id', idParam) id: string) {
    return this.vault.disable(p.tenantId, p.userId, id);
  }

  @HttpCode(204)
  @Delete('credentials/:id')
  async remove(@TenantUser() p: TenantPrincipal, @Param('id', idParam) id: string) {
    await this.vault.remove(p.tenantId, p.userId, id);
  }

  /** Modelos que el proveedor ofrece a esta clave (petición real) */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('credentials/:id/models')
  async models(@TenantUser() p: TenantPrincipal, @Param('id', idParam) id: string) {
    const c = await this.vault.get(p.tenantId, id);
    const list = await this.providers.get(c.provider)!.listModels(this.vault.open(c));
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** El asistente usa esta clave propia y este modelo */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put('assignment')
  assign(@TenantUser() p: TenantPrincipal, @Body({ schema: assignmentBody }) b: z.infer<typeof assignmentBody>) {
    return this.center.assign(p.tenantId, 'ASSISTANT', p.userId, b, false);
  }

  @HttpCode(204)
  @Delete('assignment')
  async unassign(@TenantUser() p: TenantPrincipal) {
    await this.center.unassign(p.tenantId, 'ASSISTANT', p.userId, false);
  }

  /** Prueba real del modelo asignado (genera una respuesta corta y la registra en el consumo) */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('assignment/test')
  testAssignment(@TenantUser() p: TenantPrincipal) {
    return this.center.testAssignment(p.tenantId, 'ASSISTANT', p.userId);
  }
}
