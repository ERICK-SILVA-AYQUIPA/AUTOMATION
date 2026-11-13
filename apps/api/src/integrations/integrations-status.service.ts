import { Injectable } from '@nestjs/common';
import { AssistantService } from '../ai/assistant.service.js';
import { DatabaseService } from '../database/database.service.js';
import { MailService } from '../mail/mail.service.js';
import { IntegrationChecks } from './integration-checks.service.js';

const DAY = 24 * 3600 * 1000;
export type IntegrationState = 'connected' | 'error' | 'not_configured' | 'pending' | 'managed';

/**
 * Estado de las integraciones de una empresa calculado con datos reales
 * (ADR 042). Lo usan el centro de integraciones y el paquete de entrega.
 */
@Injectable()
export class IntegrationsStatus {
  constructor(
    private readonly db: DatabaseService,
    private readonly assistant: AssistantService,
    private readonly mail: MailService,
    private readonly checks: IntegrationChecks,
  ) {}

  async overview(tenantId: string) {
    const provider = await this.assistant.providerFor(tenantId);
    return this.db.tenant(tenantId, async (tx) => {
      const since = new Date(Date.now() - 7 * DAY);
      const [numbers, own, chatwoot, endpoints, failedDeliveries, failedAutomations, lastChecks] = await Promise.all([
        tx.whatsappNumber.findMany({ where: { isActive: true }, select: { status: true, lastWebhookAt: true, lastError: true, displayPhone: true } }),
        tx.tenantIntegration.findUnique({ where: { tenantId_type: { tenantId: tenantId, type: 'GEMINI' } }, select: { status: true, config: true, lastError: true, lastCheckedAt: true } }),
        tx.tenantIntegration.findUnique({ where: { tenantId_type: { tenantId: tenantId, type: 'CHATWOOT' } }, select: { status: true, lastError: true, updatedAt: true } }),
        tx.webhookEndpoint.findMany({ where: { isActive: true }, select: { lastError: true, lastDeliveryAt: true } }),
        tx.webhookDelivery.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
        tx.automationEvent.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
        tx.$queryRaw<{ service: string; ok: boolean; detail: string | null; created_at: Date }[]>`
          SELECT DISTINCT ON (service) service, ok, detail, created_at FROM integration_checks ORDER BY service, created_at DESC`,
      ]);
      const last = (s: string) => {
        const c = lastChecks.find((x) => x.service === s);
        return c ? { ok: c.ok, detail: c.detail, at: c.created_at } : null;
      };
      const waError = numbers.find((n) => n.status === 'ERROR');
      const lastWebhook = numbers.map((n) => n.lastWebhookAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime()).at(-1) ?? null;
      const failingEndpoints = endpoints.filter((e) => e.lastError).length;
      const ownHint = (own?.config as { hint?: string } | null)?.hint ?? null;
      return [
        {
          key: 'whatsapp', name: 'WhatsApp Business (Cloud API)', testable: numbers.length > 0, lastCheck: last('whatsapp'),
          status: !numbers.length ? 'not_configured' : waError ? 'error' : numbers.every((n) => n.status === 'CONNECTED') ? 'connected' : 'pending',
          detail: !numbers.length ? 'Sin números conectados' : waError ? `${waError.displayPhone ?? 'Un número'}: ${waError.lastError ?? 'error'}` : `${numbers.length} número(s); último mensaje recibido ${lastWebhook ? 'registrado' : 'aún no llega'}`,
          lastActivityAt: lastWebhook, howTo: 'Abajo, en «Números de WhatsApp»: credenciales de Meta, URL del webhook y prueba de envío.',
        },
        {
          key: 'ai', name: 'Gemini (asistente IA)', testable: !!provider, lastCheck: last('ai'),
          status: own?.status === 'ERROR' ? 'error' : provider ? 'connected' : 'not_configured',
          detail: provider?.source === 'tenant' ? `Clave propia de la empresa (${ownHint ?? 'guardada'})` : provider ? 'Usa la clave de la plataforma' : 'Sin clave: los mensajes los atiende tu equipo',
          ownKey: own ? { hint: ownHint, status: own.status, lastError: own.lastError, lastCheckedAt: own.lastCheckedAt } : null,
          howTo: 'Opcional: crea una clave en Google AI Studio (aistudio.google.com → Get API key) y pégala aquí. Se valida con Google antes de guardarla y se guarda cifrada.',
        },
        {
          key: 'email', name: 'Correo saliente', testable: this.mail.configured, lastCheck: last('email'),
          status: this.mail.configured ? 'managed' : 'not_configured',
          detail: this.mail.configured ? 'Lo gestiona la plataforma (invitaciones, avisos y automatizaciones)' : 'La plataforma aún no configuró el servidor de correo',
          howTo: '«Probar» te envía un correo de prueba a tu dirección.',
        },
        {
          key: 'automations', name: 'Automatizaciones (n8n)', testable: false, lastCheck: null,
          status: !this.checks.configured('n8n') ? 'not_configured' : failedAutomations ? 'error' : 'managed',
          detail: !this.checks.configured('n8n') ? 'n8n no está configurado en el servidor: los avisos por correo quedan omitidos' : failedAutomations ? `${failedAutomations} ejecución(es) fallida(s) en 7 días` : 'Lo gestiona la plataforma',
          howTo: 'Actívalas y revisa su historial en Automatizaciones.',
        },
        {
          key: 'chatwoot', name: 'Chatwoot (bandeja de agentes)', testable: false, lastCheck: null,
          status: !chatwoot ? 'not_configured' : chatwoot.status === 'CONNECTED' ? 'connected' : chatwoot.status === 'ERROR' ? 'error' : 'pending',
          detail: !chatwoot ? 'Sin conectar (opcional)' : (chatwoot.lastError ?? 'Cuenta creada'),
          howTo: 'Abajo, en «Chatwoot».',
        },
        {
          key: 'webhooks', name: 'Webhooks salientes', testable: endpoints.length > 0, lastCheck: last('webhooks'),
          status: !endpoints.length ? 'not_configured' : failingEndpoints || failedDeliveries ? 'error' : 'connected',
          detail: !endpoints.length ? 'Sin URLs: avisa a tus sistemas de pedidos, stock y derivaciones' : `${endpoints.length} URL(s)${failingEndpoints ? `, ${failingEndpoints} con error` : ''}${failedDeliveries ? `; ${failedDeliveries} entrega(s) fallida(s) en 7 días` : ''}`,
          howTo: 'Abajo, en «Webhooks»: cada entrega va firmada con HMAC-SHA256.',
        },
        {
          key: 'payments', name: 'Pagos', testable: false, lastCheck: null, status: 'managed',
          detail: 'Cobro manual: la plataforma registra tus pagos. No hay cobros automáticos.',
          howTo: 'Tu plan y tus pagos están en Configuración.',
        },
      ];
    });
  }
}
