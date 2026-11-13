import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { GeminiChatModel } from '../ai/gemini.client.js';
import { ChatwootClient } from '../chatwoot/chatwoot.client.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { REDIS } from '../health/redis.provider.js';
import { MailService } from '../mail/mail.service.js';

export interface CheckResult { ok: boolean; ms: number; detail: string }

/** Servicios del servidor que ve el administrador de la plataforma (ADR 042) */
export const PLATFORM_SERVICES = {
  database: { name: 'Base de datos (PostgreSQL)', env: ['APP_DB_NAME', 'APP_DB_RUNTIME_USER', 'APP_DB_SYSTEM_USER', 'POSTGRES_HOST_PORT'], doc: 'docs/installation/production.md' },
  redis: { name: 'Colas (Redis)', env: ['REDIS_HOST', 'REDIS_HOST_PORT', 'REDIS_PASSWORD'], doc: 'docs/installation/production.md' },
  gemini: { name: 'Gemini (IA)', env: ['GEMINI_API_KEY', 'GEMINI_MODEL'], doc: 'docs/integrations/gemini.md' },
  smtp: { name: 'Correo (SMTP)', env: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_SECURE', 'MAIL_FROM'], doc: 'docs/installation/production.md' },
  n8n: { name: 'n8n (automatizaciones)', env: ['N8N_WEBHOOK_BASE_URL', 'N8N_INTERNAL_TOKEN', 'N8N_API_BASE_URL'], doc: 'services/n8n/README.md' },
  chatwoot: { name: 'Chatwoot (bandeja de agentes)', env: ['CHATWOOT_BASE_URL', 'CHATWOOT_PLATFORM_TOKEN', 'CHATWOOT_WEBHOOK_BASE_URL'], doc: 'docs/integrations/chatwoot.md' },
} as const;
export type PlatformService = keyof typeof PLATFORM_SERVICES;

const timed = async (fn: () => Promise<string>): Promise<CheckResult> => {
  const t = Date.now();
  try {
    const detail = await fn();
    return { ok: true, ms: Date.now() - t, detail };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, detail: ((e as Error).message || 'Error').slice(0, 300) };
  }
};

/**
 * Comprobaciones reales de cada servicio (nunca se marca algo como conectado
 * sin una respuesta del servicio). Cada resultado queda en `integration_checks`
 * para mostrar la última comprobación y el historial de errores.
 */
@Injectable()
export class IntegrationChecks {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly gemini: GeminiChatModel,
    private readonly chatwoot: ChatwootClient,
    private readonly mail: MailService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** ¿Está configurado en el servidor? (sin configurar no se prueba) */
  configured(s: PlatformService): boolean {
    switch (s) {
      case 'gemini': return !!this.env.GEMINI_API_KEY;
      case 'smtp': return this.mail.configured;
      case 'n8n': return !!this.env.N8N_WEBHOOK_BASE_URL && !!this.env.N8N_INTERNAL_TOKEN;
      case 'chatwoot': return !!this.env.CHATWOOT_PLATFORM_TOKEN;
      default: return true;
    }
  }

  async runPlatform(s: PlatformService): Promise<CheckResult> {
    if (!this.configured(s)) return { ok: false, ms: 0, detail: `No configurado: define ${PLATFORM_SERVICES[s].env.join(', ')} en el .env del servidor` };
    switch (s) {
      case 'database':
        return timed(async () => (await this.db.ping(), 'Responde'));
      case 'redis':
        return timed(async () => `Responde (${await this.redis.ping()})`);
      case 'gemini':
        return this.gemini.check();
      case 'smtp':
        return timed(async () => (await this.mail.verify(), 'Conexión y autenticación correctas'));
      case 'n8n':
        return timed(async () => {
          const url = `${new URL(this.env.N8N_WEBHOOK_BASE_URL).origin}/healthz`;
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) throw new Error(`n8n respondió ${res.status} en /healthz`);
          return 'n8n responde';
        });
      case 'chatwoot':
        return timed(async () => {
          await this.chatwoot.platform<unknown>('GET', '/agent_bots');
          return 'Token de la Platform App aceptado';
        });
    }
  }

  /** Guarda el resultado (tenantId null = de la plataforma, con el rol de sistema) */
  async record(tenantId: string | null, service: string, r: CheckResult, userId: string | null) {
    const data = { tenantId, service, ok: r.ok, latencyMs: Math.round(r.ms), detail: r.detail.slice(0, 500), checkedById: userId };
    if (tenantId) await this.db.tenant(tenantId, (tx) => tx.integrationCheck.create({ data }));
    else await this.db.system.integrationCheck.create({ data });
  }
}
