import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AiCenter } from '../ai/center/ai-center.service.js';
import { CredentialVault } from '../ai/center/credential-vault.service.js';
import { ModelCatalog } from '../ai/center/model-catalog.service.js';
import { AiProviders, CENTER_CATALOG } from '../ai/providers/registry.js';
import { STATUS_LABEL } from '../ai/providers/types.js';
import type { Principal } from '../common/context/principal.js';
import { CurrentUser, RequirePermission } from '../common/decorators/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';
import { assignmentBody, credentialBody, providerCards, rotateBody } from './ai-integrations.controller.js';

const idParam = { schema: z.uuid() };
const serviceParam = { schema: z.enum(['ASSISTANT', 'COMMERCIAL']) };
const price = z.string().regex(/^\d{1,8}(\.\d{1,4})?$/, 'Precio con hasta 4 decimales').nullable();
const managedCredentialBody = credentialBody.extend({ monthlyTokenLimit: z.number().int().positive().max(10_000_000_000).nullable().optional() }).strict();

/**
 * Centro de APIs de la plataforma (ADR 046): credenciales administradas
 * (asignables a empresas), catálogo de modelos con precios, asignación de IA por
 * empresa y servicio, prueba real y consumo. Nunca devuelve secretos.
 */
@RequirePermission('platform:manage')
@Controller('platform/api-center')
export class ApiCenterController {
  constructor(
    private readonly db: DatabaseService,
    private readonly vault: CredentialVault,
    private readonly models: ModelCatalog,
    private readonly center: AiCenter,
    private readonly providers: AiProviders,
  ) {}

  @Get()
  async overview() {
    const [credentials, models, assignments, usage, tenants, ownCounts] = await Promise.all([
      this.vault.list(null),
      this.models.list(),
      this.db.system.aiAssignment.findMany({
        orderBy: [{ tenantId: 'asc' }, { service: 'asc' }],
        select: { id: true, tenantId: true, service: true, provider: true, mode: true, model: true, profile: true, monthlyTokenLimit: true, isActive: true, fallbackModel: true, allowCrossProviderFallback: true, updatedAt: true, credential: { select: { label: true, secretHint: true, status: true } } },
      }),
      this.center.usage(null),
      this.db.system.tenant.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, status: true } }),
      this.db.system.providerCredential.groupBy({ by: ['tenantId', 'provider'], where: { tenantId: { not: null }, disabledAt: null }, _count: { _all: true } }),
    ]);
    return {
      catalog: CENTER_CATALOG,
      providers: providerCards(this.providers),
      statusLabels: STATUS_LABEL,
      credentials,
      models: models.map((m) => ({ ...m, inputPricePerMTok: m.inputPricePerMTok?.toString() ?? null, outputPricePerMTok: m.outputPricePerMTok?.toString() ?? null })),
      assignments,
      tenants,
      /** Claves propias de cada empresa (solo cuántas y de qué proveedor) */
      ownCredentials: ownCounts.map((c) => ({ tenantId: c.tenantId, provider: c.provider, count: c._count._all })),
      usage,
    };
  }

  // ----------------------------------------------------------- credenciales administradas

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('credentials')
  create(@CurrentUser() u: Principal, @Body({ schema: managedCredentialBody }) b: z.infer<typeof managedCredentialBody>) {
    return this.vault.create(null, u.userId, b);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('credentials/:id/rotate')
  rotate(@CurrentUser() u: Principal, @Param('id', idParam) id: string, @Body({ schema: rotateBody }) b: z.infer<typeof rotateBody>) {
    return this.vault.rotate(null, u.userId, id, b.fields);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('credentials/:id/test')
  test(@CurrentUser() u: Principal, @Param('id', idParam) id: string) {
    return this.vault.test(null, u.userId, id);
  }

  @HttpCode(200)
  @Post('credentials/:id/disable')
  disable(@CurrentUser() u: Principal, @Param('id', idParam) id: string) {
    return this.vault.disable(null, u.userId, id);
  }

  @HttpCode(200)
  @Patch('credentials/:id')
  async limits(@CurrentUser() u: Principal, @Param('id', idParam) id: string, @Body({ schema: z.object({ monthlyTokenLimit: z.number().int().positive().max(10_000_000_000).nullable(), label: z.string().trim().min(1).max(80).optional() }).strict() }) b: { monthlyTokenLimit: number | null; label?: string }) {
    await this.vault.get(null, id);
    return this.db.system.$transaction(async (tx) => {
      const r = await tx.providerCredential.update({ where: { id }, data: b, select: { id: true, label: true, monthlyTokenLimit: true } });
      await tx.auditLog.create({ data: { tenantId: null, userId: u.userId, action: 'api_center.credential_limits', entityType: 'provider_credential', entityId: id, metadata: b } });
      return r;
    });
  }

  @HttpCode(204)
  @Delete('credentials/:id')
  async remove(@CurrentUser() u: Principal, @Param('id', idParam) id: string) {
    await this.vault.remove(null, u.userId, id);
  }

  // ----------------------------------------------------------- catálogo de modelos

  /** Lee los modelos del proveedor con esta credencial (petición real) */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('credentials/:id/models/refresh')
  refresh(@CurrentUser() u: Principal, @Param('id', idParam) id: string) {
    return this.models.refresh(null, u.userId, id);
  }

  @Post('models')
  addModel(@CurrentUser() u: Principal, @Body({ schema: z.object({ provider: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), modelId: z.string().trim().regex(/^[\w.:/-]{1,120}$/), displayName: z.string().trim().max(120).optional() }).strict() }) b: { provider: string; modelId: string; displayName?: string }) {
    return this.models.addManual(u.userId, b);
  }

  @Patch('models/:id')
  updateModel(
    @CurrentUser() u: Principal,
    @Param('id', idParam) id: string,
    @Body({ schema: z.object({ isEnabled: z.boolean().optional(), inputPricePerMTok: price.optional(), outputPricePerMTok: price.optional(), priceCurrency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict() }) b: { isEnabled?: boolean; inputPricePerMTok?: string | null; outputPricePerMTok?: string | null; priceCurrency?: string },
  ) {
    return this.models.update(u.userId, id, b);
  }

  // ----------------------------------------------------------- asignación por empresa

  private async tenant(id: string) {
    const t = await this.db.system.tenant.findUnique({ where: { id }, select: { id: true } });
    if (!t) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Empresa no encontrada' });
  }

  /** Credenciales que se pueden asignar a la empresa: las administradas y las propias de ella */
  @Get('tenants/:tenantId/credentials')
  async tenantCredentials(@Param('tenantId', idParam) tenantId: string) {
    await this.tenant(tenantId);
    return this.db.system.providerCredential.findMany({
      where: { OR: [{ tenantId: null }, { tenantId }], disabledAt: null },
      orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, tenantId: true, provider: true, label: true, secretHint: true, status: true },
    });
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Put('tenants/:tenantId/ai/:service')
  async assign(@CurrentUser() u: Principal, @Param('tenantId', idParam) tenantId: string, @Param('service', serviceParam) service: 'ASSISTANT' | 'COMMERCIAL', @Body({ schema: assignmentBody }) b: z.infer<typeof assignmentBody>) {
    await this.tenant(tenantId);
    return this.center.assign(tenantId, service, u.userId, b, true);
  }

  @HttpCode(200)
  @Post('tenants/:tenantId/ai/:service/:action')
  async toggle(@CurrentUser() u: Principal, @Param('tenantId', idParam) tenantId: string, @Param('service', serviceParam) service: 'ASSISTANT' | 'COMMERCIAL', @Param('action', { schema: z.enum(['enable', 'disable', 'test']) }) action: 'enable' | 'disable' | 'test') {
    await this.tenant(tenantId);
    if (action === 'test') return this.center.testAssignment(tenantId, service, u.userId);
    return this.center.setActive(tenantId, service, u.userId, action === 'enable');
  }

  @HttpCode(204)
  @Delete('tenants/:tenantId/ai/:service')
  async unassign(@CurrentUser() u: Principal, @Param('tenantId', idParam) tenantId: string, @Param('service', serviceParam) service: 'ASSISTANT' | 'COMMERCIAL') {
    await this.tenant(tenantId);
    await this.center.unassign(tenantId, service, u.userId, true);
  }
}
