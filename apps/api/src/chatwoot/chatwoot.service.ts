import { BadRequestException, ConflictException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { decrypt, encrypt, randomToken } from '../common/crypto/crypto.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import type { TenantIntegration } from '../generated/prisma/client.js';
import { ChatwootApiError, ChatwootClient } from './chatwoot.client.js';

/** Configuración no secreta guardada en tenant_integrations.config */
export interface ChatwootConfig {
  accountId?: number;
  botUserId?: number;
  inboxId?: number;
  inboxIdentifier?: string;
}
/** Secretos (cifrados en tenant_integrations.secrets_enc) */
export interface ChatwootSecrets {
  botToken?: string;
  webhookSecret?: string;
}
export interface ChatwootContext {
  tenantId: string;
  cfg: Required<Pick<ChatwootConfig, 'accountId' | 'botUserId' | 'inboxId'>>;
  botToken: string;
  webhookSecret: string;
}

const ROLE_IN_CHATWOOT: Record<string, 'administrator' | 'agent'> = { TENANT_ADMIN: 'administrator', SUPERVISOR: 'administrator', SELLER: 'agent' };

/**
 * Una cuenta de Chatwoot por empresa, creada con la Platform API, con un usuario
 * de integración (administrador) y un buzón de tipo API cuyo webhook apunta a
 * nuestra API. Los usuarios del panel entran a Chatwoot con inicio de sesión
 * único (enlace de un solo uso de la Platform API), sin contraseña aparte.
 */
@Injectable()
export class ChatwootService {
  private readonly log = new Logger('Chatwoot');

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly cw: ChatwootClient,
  ) {}

  private enc = (v: ChatwootSecrets) => encrypt(JSON.stringify(v), this.env.DATA_ENCRYPTION_KEY);
  private dec = (v: string | null): ChatwootSecrets => (v ? (JSON.parse(decrypt(v, this.env.DATA_ENCRYPTION_KEY)) as ChatwootSecrets) : {});

  webhookUrl(key: string) {
    return `${this.env.CHATWOOT_WEBHOOK_BASE_URL.replace(/\/$/, '')}/api/v1/webhooks/chatwoot/${key}`;
  }

  view(i: TenantIntegration | null) {
    const cfg = (i?.config ?? {}) as ChatwootConfig;
    return {
      available: this.cw.configured,
      status: i?.status ?? 'DISCONNECTED',
      lastError: i?.lastError ?? null,
      accountId: cfg.accountId ?? null,
      inboxId: cfg.inboxId ?? null,
      updatedAt: i?.updatedAt ?? null,
    };
  }

  async get(p: TenantPrincipal) {
    const i = await this.db.tenant(p.tenantId, (tx) => tx.tenantIntegration.findUnique({ where: { tenantId_type: { tenantId: p.tenantId, type: 'CHATWOOT' } } }));
    return this.view(i);
  }

  /** Contexto listo para usar (solo si la integración está conectada) */
  async context(tenantId: string): Promise<ChatwootContext | null> {
    const i = await this.db.system.tenantIntegration.findUnique({ where: { tenantId_type: { tenantId, type: 'CHATWOOT' } } });
    return i ? this.toContext(i) : null;
  }

  toContext(i: TenantIntegration): ChatwootContext | null {
    if (i.status !== 'CONNECTED') return null;
    const cfg = i.config as ChatwootConfig;
    const s = this.dec(i.secretsEnc);
    if (!cfg.accountId || !cfg.botUserId || !cfg.inboxId || !s.botToken || !s.webhookSecret) return null;
    return { tenantId: i.tenantId, cfg: { accountId: cfg.accountId, botUserId: cfg.botUserId, inboxId: cfg.inboxId }, botToken: s.botToken, webhookSecret: s.webhookSecret };
  }

  /**
   * Crea (o completa) la cuenta de Chatwoot de la empresa. Idempotente: guarda cada
   * paso, así un fallo a mitad se reanuda sin crear cuentas duplicadas.
   */
  async connect(p: TenantPrincipal) {
    if (!this.cw.configured) throw new BadRequestException({ code: 'CHATWOOT_NOT_CONFIGURED', message: 'Chatwoot no está configurado en el servidor (CHATWOOT_PLATFORM_TOKEN)' });
    const tenant = await this.db.tenant(p.tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: p.tenantId }, select: { name: true } }));
    let i = await this.db.system.tenantIntegration.upsert({
      where: { tenantId_type: { tenantId: p.tenantId, type: 'CHATWOOT' } },
      create: { tenantId: p.tenantId, type: 'CHATWOOT', status: 'PENDING', webhookKey: randomToken(24) },
      update: {},
    });
    if (i.status === 'CONNECTED' && this.toContext(i)) return this.view(i);
    // Bloqueo optimista: solo una petición provisiona a la vez
    const claimed = await this.db.system.tenantIntegration.updateMany({ where: { id: i.id, updatedAt: i.updatedAt }, data: { status: 'PENDING', lastError: null } });
    if (!claimed.count) throw new ConflictException('La conexión con Chatwoot ya está en curso');

    const cfg = { ...((i.config ?? {}) as ChatwootConfig) };
    const sec = this.dec(i.secretsEnc);
    const save = async () => {
      i = await this.db.system.tenantIntegration.update({ where: { id: i.id }, data: { config: { ...cfg }, secretsEnc: this.enc(sec) } });
    };
    try {
      if (!cfg.accountId) {
        cfg.accountId = (await this.cw.createAccount(tenant.name)).id;
        await save();
      }
      if (!cfg.botUserId) {
        // Usuario técnico propio de la empresa; su correo no recibe nada (dominio .invalid, RFC 2606)
        const bot = await this.cw.createUser({ name: 'Asistente AI Sales', email: `aisa-bot-${p.tenantId}@aisa.invalid`, password: `Aa1!${randomToken(24)}` });
        await this.cw.addAccountUser(cfg.accountId, bot.id, 'administrator');
        cfg.botUserId = bot.id;
        await save();
      }
      if (!sec.botToken) {
        sec.botToken = (await this.cw.userToken(cfg.botUserId)).access_token;
        await save();
      }
      if (!cfg.inboxId) {
        const inbox = await this.cw.createApiInbox(cfg.accountId, sec.botToken, 'WhatsApp', this.webhookUrl(i.webhookKey!));
        cfg.inboxId = inbox.id;
        await save();
      }
      const inbox = await this.cw.getInbox(cfg.accountId, sec.botToken, cfg.inboxId);
      if (!inbox.secret) throw new Error('Chatwoot no devolvió el secreto del buzón (¿el usuario de integración no es administrador?)');
      sec.webhookSecret = inbox.secret;
      cfg.inboxIdentifier = inbox.inbox_identifier;
      i = await this.db.system.tenantIntegration.update({ where: { id: i.id }, data: { config: { ...cfg }, secretsEnc: this.enc(sec), status: 'CONNECTED', lastError: null } });
      await this.audit.system({ tenantId: p.tenantId, userId: p.userId, action: 'chatwoot.connected', entityType: 'tenant_integration', entityId: i.id, metadata: { accountId: cfg.accountId, inboxId: cfg.inboxId } });
      return this.view(i);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.db.system.tenantIntegration.update({ where: { id: i.id }, data: { status: 'ERROR', lastError: msg.slice(0, 500) } });
      this.log.warn(`No se pudo conectar Chatwoot (empresa ${p.tenantId}): ${msg}`);
      if (e instanceof ChatwootApiError) throw new ServiceUnavailableException({ code: 'CHATWOOT_ERROR', message: `Chatwoot respondió con un error: ${msg}` });
      throw e;
    }
  }

  /**
   * Retira el acceso a Chatwoot de un usuario del panel (desactivado o con otro rol).
   * Si vuelve a entrar, el siguiente inicio de sesión único lo añade con su rol actual.
   * Si Chatwoot falla se lanza el error y se conserva chatwootUserId, así repetir la
   * operación vuelve a intentarlo: nunca se da por retirado un acceso que sigue activo.
   */
  async revokeUser(tenantId: string, userId: string) {
    const user = await this.db.tenant(tenantId, (tx) => tx.user.findFirst({ where: { id: userId, tenantId }, select: { chatwootUserId: true } }));
    if (!user?.chatwootUserId) return;
    const ctx = await this.context(tenantId);
    if (ctx) {
      try {
        await this.cw.removeAccountUser(ctx.cfg.accountId, user.chatwootUserId);
      } catch (e) {
        if (e instanceof ChatwootApiError) {
          throw new ServiceUnavailableException({ code: 'CHATWOOT_ERROR', message: `El cambio se guardó, pero no se pudo retirar el acceso a Chatwoot (${e.message}). Repite la operación.` });
        }
        throw e;
      }
    }
    await this.db.tenant(tenantId, (tx) => tx.user.update({ where: { id: userId }, data: { chatwootUserId: null } }));
  }

  /**
   * Enlace de acceso único a Chatwoot para el usuario del panel. Crea su agente
   * la primera vez, con rol según su rol en la empresa, y lo añade al buzón.
   */
  async sso(p: TenantPrincipal): Promise<{ url: string }> {
    const ctx = await this.context(p.tenantId);
    if (!ctx) throw new BadRequestException({ code: 'CHATWOOT_NOT_CONNECTED', message: 'Activa primero la bandeja de agentes en Integraciones' });
    const user = await this.db.tenant(p.tenantId, (tx) => tx.user.findFirstOrThrow({ where: { id: p.userId, tenantId: p.tenantId }, select: { id: true, name: true, email: true, role: true, chatwootUserId: true } }));
    let cwUserId = user.chatwootUserId;
    try {
      if (!cwUserId) {
        const u = await this.cw.createUser({ name: user.name, email: user.email, password: `Aa1!${randomToken(24)}` });
        await this.cw.addAccountUser(ctx.cfg.accountId, u.id, ROLE_IN_CHATWOOT[user.role] ?? 'agent');
        await this.cw.addInboxMembers(ctx.cfg.accountId, ctx.botToken, ctx.cfg.inboxId, [u.id]);
        cwUserId = u.id;
        await this.db.tenant(p.tenantId, (tx) => tx.user.update({ where: { id: user.id }, data: { chatwootUserId: u.id } }));
      }
      return await this.cw.ssoLink(cwUserId);
    } catch (e) {
      if (e instanceof ChatwootApiError) throw new ServiceUnavailableException({ code: 'CHATWOOT_ERROR', message: `No se pudo abrir Chatwoot: ${e.message}` });
      throw e;
    }
  }
}
