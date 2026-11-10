import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { decrypt, encrypt, randomToken } from '../common/crypto/crypto.js';
import { getPlanLimits } from '../plans/plan-limits.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { CloudApiClient, WhatsappApiError, type Recipient } from './cloud-api.client.js';
import type { WhatsappNumber } from '../generated/prisma/client.js';

const graphId = z.string().trim().regex(/^\d{5,30}$/, 'Debe ser el ID numérico que muestra Meta');
export const createCloudNumberSchema = z.object({
  label: z.string().trim().max(60).optional(),
  phoneNumberId: graphId,
  wabaId: graphId.optional(),
  accessToken: z.string().trim().min(20).max(2048),
  appSecret: z.string().trim().regex(/^[0-9a-f]{16,128}$/i, 'App Secret inválido (hexadecimal)'),
});
export const updateNumberSchema = z
  .object({
    label: z.string().trim().max(60).nullable().optional(),
    accessToken: z.string().trim().min(20).max(2048).optional(),
    appSecret: z.string().trim().regex(/^[0-9a-f]{16,128}$/i, 'App Secret inválido (hexadecimal)').optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar');
export const testMessageSchema = z.object({
  to: z.string().transform((v) => v.replace(/\D/g, '')).refine((v) => /^\d{8,15}$/.test(v), 'Teléfono inválido (formato internacional)'),
  template: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'Nombre de plantilla inválido'),
  language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Código de idioma inválido, p. ej. es o en_US'),
});

/** Campos que se pueden mostrar (nunca secretos) */
const publicView = (n: WhatsappNumber, env: Env) => ({
  id: n.id, provider: n.provider, label: n.label, displayPhone: n.displayPhone, phoneNumberId: n.phoneNumberId, wabaId: n.wabaId,
  evolutionInstance: n.evolutionInstance, status: n.status, lastError: n.lastError, isActive: n.isActive, lastWebhookAt: n.lastWebhookAt,
  createdAt: n.createdAt, hasAccessToken: !!n.accessTokenEnc, hasAppSecret: !!n.appSecretEnc,
  webhookUrl: `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/webhooks/whatsapp/${n.webhookKey}`,
});

@Injectable()
export class WhatsappNumbersService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly cloud: CloudApiClient,
  ) {}

  private enc = (v: string) => encrypt(v, this.env.DATA_ENCRYPTION_KEY);
  private dec = (v: string) => decrypt(v, this.env.DATA_ENCRYPTION_KEY);

  list(p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, async (tx) => (await tx.whatsappNumber.findMany({ where: { tenantId: p.tenantId }, orderBy: { createdAt: 'asc' } })).map((n) => publicView(n, this.env)));
  }

  private async find(tx: Tx, tenantId: string, id: string) {
    const n = await tx.whatsappNumber.findFirst({ where: { id, tenantId } });
    if (!n) throw new NotFoundException('Número no encontrado');
    return n;
  }

  /** Comprueba token + phone_number_id contra Meta; devuelve el número visible */
  private async verify(phoneNumberId: string, token: string) {
    try {
      return await this.cloud.phoneNumberInfo(phoneNumberId, token);
    } catch (e) {
      if (e instanceof WhatsappApiError) throw new BadRequestException({ code: 'WHATSAPP_VERIFY_FAILED', message: `Meta rechazó las credenciales: ${e.message}${e.code ? ` (código ${e.code})` : ''}` });
      throw e;
    }
  }

  async createCloud(p: TenantPrincipal, input: z.infer<typeof createCloudNumberSchema>) {
    // Antes de guardar nada: las credenciales deben funcionar de verdad
    const info = await this.verify(input.phoneNumberId, input.accessToken);
    return this.db.tenant(p.tenantId, async (tx) => {
      const limits = await getPlanLimits(tx);
      const count = await tx.whatsappNumber.count({ where: { tenantId: p.tenantId, isActive: true } });
      if (count >= limits.maxWhatsappNumbers) throw new ForbiddenException({ code: 'PLAN_LIMIT_REACHED', message: `Tu plan permite ${limits.maxWhatsappNumbers} número(s) de WhatsApp` });
      const taken = await this.db.system.whatsappNumber.findUnique({ where: { phoneNumberId: input.phoneNumberId }, select: { tenantId: true } });
      if (taken) throw new ConflictException(taken.tenantId === p.tenantId ? 'Ese número ya está registrado' : 'Ese número ya está registrado en otra cuenta');
      const n = await tx.whatsappNumber.create({
        data: {
          tenantId: p.tenantId, provider: 'CLOUD_API', label: input.label, phoneNumberId: input.phoneNumberId, wabaId: input.wabaId,
          displayPhone: (info.display_phone_number ?? '').replace(/\D/g, '') || input.phoneNumberId,
          accessTokenEnc: this.enc(input.accessToken), appSecretEnc: this.enc(input.appSecret),
          webhookKey: randomToken(24), verifyTokenEnc: this.enc(randomToken(24)), status: 'CONNECTED',
        },
      });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'whatsapp.number_added', entityType: 'whatsapp_number', entityId: n.id, metadata: { phoneNumberId: input.phoneNumberId, verifiedName: info.verified_name ?? null } });
      return { ...publicView(n, this.env), verifiedName: info.verified_name ?? null, qualityRating: info.quality_rating ?? null };
    });
  }

  async update(p: TenantPrincipal, id: string, input: z.infer<typeof updateNumberSchema>) {
    const current = await this.db.tenant(p.tenantId, (tx) => this.find(tx, p.tenantId, id));
    if (input.accessToken && current.provider === 'CLOUD_API') await this.verify(current.phoneNumberId!, input.accessToken);
    return this.db.tenant(p.tenantId, async (tx) => {
      if (input.isActive === true && !current.isActive) {
        const limits = await getPlanLimits(tx);
        const count = await tx.whatsappNumber.count({ where: { tenantId: p.tenantId, isActive: true } });
        if (count >= limits.maxWhatsappNumbers) throw new ForbiddenException({ code: 'PLAN_LIMIT_REACHED', message: `Tu plan permite ${limits.maxWhatsappNumbers} número(s) de WhatsApp` });
      }
      const n = await tx.whatsappNumber.update({
        where: { id },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.accessToken ? { accessTokenEnc: this.enc(input.accessToken), status: 'CONNECTED', lastError: null } : {}),
          ...(input.appSecret ? { appSecretEnc: this.enc(input.appSecret) } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'whatsapp.number_updated', entityType: 'whatsapp_number', entityId: id, metadata: { label: input.label ?? null, tokenChanged: !!input.accessToken, secretChanged: !!input.appSecret, isActive: input.isActive ?? null } });
      return publicView(n, this.env);
    });
  }

  /** URL y verify token para configurar el webhook en Meta (solo administradores) */
  async webhookConfig(p: TenantPrincipal, id: string) {
    const n = await this.db.tenant(p.tenantId, (tx) => this.find(tx, p.tenantId, id));
    return { webhookUrl: publicView(n, this.env).webhookUrl, verifyToken: n.verifyTokenEnc ? this.dec(n.verifyTokenEnc) : null, field: 'messages' };
  }

  /** Vuelve a comprobar las credenciales con Meta y actualiza el estado */
  async check(p: TenantPrincipal, id: string) {
    const n = await this.db.tenant(p.tenantId, (tx) => this.find(tx, p.tenantId, id));
    if (n.provider !== 'CLOUD_API' || !n.accessTokenEnc || !n.phoneNumberId) throw new BadRequestException('Este número no usa WhatsApp Cloud API');
    let ok = true;
    let error: string | null = null;
    let info = null;
    try {
      info = await this.cloud.phoneNumberInfo(n.phoneNumberId, this.dec(n.accessTokenEnc));
    } catch (e) {
      if (!(e instanceof WhatsappApiError)) throw e;
      ok = false;
      error = `${e.message}${e.code ? ` (código ${e.code})` : ''}`;
    }
    const updated = await this.db.tenant(p.tenantId, (tx) => tx.whatsappNumber.update({ where: { id }, data: { status: ok ? 'CONNECTED' : 'ERROR', lastError: error } }));
    return { ...publicView(updated, this.env), verifiedName: info?.verified_name ?? null, qualityRating: info?.quality_rating ?? null };
  }

  /** Envía una plantilla aprobada a un teléfono, para comprobar el envío de punta a punta */
  async sendTestTemplate(p: TenantPrincipal, id: string, input: z.infer<typeof testMessageSchema>) {
    const n = await this.db.tenant(p.tenantId, (tx) => this.find(tx, p.tenantId, id));
    if (n.provider !== 'CLOUD_API' || !n.accessTokenEnc || !n.phoneNumberId) throw new BadRequestException('Este número no usa WhatsApp Cloud API');
    const to: Recipient = { phone: input.to };
    try {
      const wamid = await this.cloud.sendTemplate(n.phoneNumberId, this.dec(n.accessTokenEnc), to, input.template, input.language);
      await this.audit.system({ tenantId: p.tenantId, userId: p.userId, action: 'whatsapp.test_message', entityType: 'whatsapp_number', entityId: id, metadata: { template: input.template, wamid } });
      return { wamid };
    } catch (e) {
      if (e instanceof WhatsappApiError) throw new BadRequestException({ code: 'WHATSAPP_SEND_FAILED', message: `WhatsApp rechazó el envío: ${e.message}${e.code ? ` (código ${e.code})` : ''}` });
      throw e;
    }
  }
}
