import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AiProviders } from '../providers/registry.js';
import { CredentialVault, type Owner } from './credential-vault.service.js';

/**
 * Catálogo de modelos (ADR 046). Los modelos salen de la API de cada proveedor
 * con una credencial real; la plataforma puede añadir uno a mano (queda marcado
 * como MANUAL) y fijar precios por millón de tokens. Sin precio no se calcula
 * costo: nunca se inventa.
 */
@Injectable()
export class ModelCatalog {
  constructor(
    private readonly db: DatabaseService,
    private readonly providers: AiProviders,
    private readonly vault: CredentialVault,
    private readonly audit: AuditService,
  ) {}

  list(provider?: string) {
    return this.db.system.aiModel.findMany({ where: provider ? { provider } : {}, orderBy: [{ provider: 'asc' }, { modelId: 'asc' }] });
  }

  /** Lee los modelos del proveedor con la credencial dada y actualiza el catálogo */
  async refresh(owner: Owner, userId: string, credentialId: string) {
    const cred = await this.vault.get(owner, credentialId);
    const adapter = this.providers.get(cred.provider);
    if (!adapter) throw new BadRequestException({ code: 'UNKNOWN_PROVIDER', message: `Proveedor sin adaptador: ${cred.provider}` });
    const models = await adapter.listModels(this.vault.open(cred)).catch((e: Error) => {
      throw new BadRequestException({ code: 'PROVIDER_ERROR', message: e.message });
    });
    const now = new Date();
    await this.db.system.$transaction(async (tx) => {
      for (const m of models) {
        const data = { displayName: m.displayName ?? null, contextWindow: m.contextWindow ?? null, maxOutputTokens: m.maxOutputTokens ?? null, lastSeenAt: now };
        await tx.aiModel.upsert({
          where: { provider_modelId: { provider: adapter.key, modelId: m.id } },
          create: { provider: adapter.key, modelId: m.id, source: 'PROVIDER', ...data },
          // Un modelo añadido a mano que el proveedor confirma pasa a ser del proveedor
          update: { ...data, source: 'PROVIDER' },
        });
      }
    });
    await this.audit.system({ tenantId: owner, userId, action: 'api_center.models_refreshed', entityType: 'ai_model', metadata: { provider: adapter.key, count: models.length } });
    return { provider: adapter.key, count: models.length, models: models.map((m) => m.id) };
  }

  async addManual(userId: string, input: { provider: string; modelId: string; displayName?: string }) {
    if (!this.providers.get(input.provider)) throw new BadRequestException({ code: 'UNKNOWN_PROVIDER', message: `Proveedor sin adaptador: ${input.provider}` });
    try {
      const m = await this.db.system.aiModel.create({ data: { provider: input.provider, modelId: input.modelId, displayName: input.displayName ?? null, source: 'MANUAL' } });
      await this.audit.system({ tenantId: null, userId, action: 'api_center.model_added', entityType: 'ai_model', entityId: m.id, metadata: { provider: input.provider, modelId: input.modelId } });
      return m;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BadRequestException({ code: 'MODEL_EXISTS', message: 'Ese modelo ya está en el catálogo' });
      throw e;
    }
  }

  async update(userId: string, id: string, input: { isEnabled?: boolean; inputPricePerMTok?: string | null; outputPricePerMTok?: string | null; priceCurrency?: string }) {
    const cur = await this.db.system.aiModel.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException({ code: 'MODEL_NOT_FOUND', message: 'Modelo no encontrado' });
    const m = await this.db.system.aiModel.update({ where: { id }, data: input });
    await this.audit.system({ tenantId: null, userId, action: 'api_center.model_updated', entityType: 'ai_model', entityId: id, metadata: { modelId: cur.modelId, ...input } });
    return m;
  }

  /** Costo de una llamada según el precio del catálogo (null si no hay precio) */
  async costOf(provider: string, model: string, input: number, output: number): Promise<{ cost: Prisma.Decimal; currency: string } | null> {
    const m = await this.db.system.aiModel.findUnique({ where: { provider_modelId: { provider, modelId: model } }, select: { inputPricePerMTok: true, outputPricePerMTok: true, priceCurrency: true } });
    if (!m?.inputPricePerMTok || !m.outputPricePerMTok) return null;
    const cost = m.inputPricePerMTok.mul(input).add(m.outputPricePerMTok.mul(output)).div(1_000_000);
    return { cost, currency: m.priceCurrency };
  }
}
