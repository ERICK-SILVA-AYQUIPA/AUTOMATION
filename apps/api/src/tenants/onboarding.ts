import { hasBusinessInfo, readProfile } from '../ai/ai-profile.js';
import type { Tx } from '../database/database.service.js';
import { subscriptionAccess } from '../plans/subscription-access.js';

export interface OnboardingTask {
  key: string;
  label: string;
  done: boolean;
  /** Obligatoria para activar la empresa */
  required: boolean;
  /** Qué falta o dónde se hace */
  hint: string;
}

export interface Onboarding {
  status: 'ACTIVE' | 'SUSPENDED' | 'ONBOARDING';
  activatedAt: Date | null;
  tasks: OnboardingTask[];
  /** Solo una empresa en preparación con todas las tareas obligatorias hechas */
  canActivate: boolean;
}

interface Options {
  graceDays: number;
  /** El servidor tiene clave del modelo de IA (configurada, no probada) */
  aiProviderConfigured: boolean;
  /** Con el rol de sistema se puede mirar si hay una invitación vigente */
  checkInvitations: boolean;
  now?: Date;
}

/**
 * Lista de puesta en marcha calculada con datos reales (nada se marca a mano):
 * la usan el panel general para decidir la activación y la propia empresa
 * para saber qué le falta.
 */
export async function computeOnboarding(tx: Tx, tenantId: string, o: Options): Promise<Onboarding> {
  const now = o.now ?? new Date();
  const t = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: {
      status: true, activatedAt: true, enabledModules: true, legalName: true, taxId: true, contactEmail: true, phone: true,
      subscription: { select: { status: true, trialEndsAt: true, currentPeriodEnd: true } },
    },
  });
  const [admins, numbers, products, aiSettings, ownKey] = await Promise.all([
    tx.user.findMany({ where: { tenantId, role: 'TENANT_ADMIN', status: { not: 'DISABLED' } }, select: { id: true, status: true } }),
    tx.whatsappNumber.findMany({ where: { tenantId, isActive: true }, select: { status: true, lastWebhookAt: true } }),
    tx.product.count({ where: { tenantId, status: 'ACTIVE' } }),
    tx.aiSettings.findUnique({ where: { tenantId }, select: { profile: true } }),
    tx.tenantIntegration.count({ where: { tenantId, type: 'GEMINI', status: 'CONNECTED' } }),
  ]);
  const aiProvider = o.aiProviderConfigured || ownKey > 0;
  const joined = admins.some((a) => a.status === 'ACTIVE');
  let invited = joined;
  if (!invited && o.checkInvitations && admins.length) {
    invited = (await tx.authToken.count({ where: { userId: { in: admins.map((a) => a.id) }, type: 'INVITATION', usedAt: null, expiresAt: { gt: now } } })) > 0;
  }
  const mod = (m: string) => t.enabledModules.includes(m);
  const access = t.subscription ? subscriptionAccess(t.subscription, o.graceDays, now) : null;

  const tasks: OnboardingTask[] = [
    { key: 'admin_invited', label: 'Invitación enviada al administrador', done: invited, required: true, hint: invited ? '' : 'Reenvía la invitación desde la ficha de la empresa' },
    { key: 'admin_joined', label: 'El administrador creó su contraseña', done: joined, required: true, hint: joined ? '' : 'Debe abrir el enlace del correo (vale 7 días)' },
    { key: 'subscription', label: 'Periodo vigente (prueba o pagado)', done: !!access && !access.readOnly, required: true, hint: access?.readOnly ? 'Registra un pago o amplía el periodo' : '' },
    { key: 'profile', label: 'Razón social, RUC y contacto', done: !!(t.legalName && t.taxId && (t.contactEmail || t.phone)), required: false, hint: 'Configuración → Empresa' },
  ];
  if (mod('conversations')) {
    const verified = numbers.some((n) => n.status === 'CONNECTED');
    const webhook = numbers.some((n) => n.status === 'CONNECTED' && n.lastWebhookAt);
    tasks.push(
      { key: 'whatsapp_verified', label: 'WhatsApp: credenciales verificadas con Meta', done: verified, required: true, hint: verified ? '' : 'Integraciones → Conectar número' },
      { key: 'whatsapp_webhook', label: 'WhatsApp: llegó el primer aviso de Meta (webhook)', done: webhook, required: true, hint: webhook ? '' : 'Configura la URL del webhook en Meta y envía un mensaje de prueba al número' },
    );
  }
  if (mod('catalog')) tasks.push({ key: 'catalog', label: 'Al menos un producto activo', done: products > 0, required: false, hint: 'Productos → Nuevo o importar CSV' });
  if (mod('ai')) {
    tasks.push(
      { key: 'ai_settings', label: 'Información del negocio para el asistente', done: hasBusinessInfo(readProfile(aiSettings?.profile)), required: false, hint: 'Asistente IA: horario, pagos, entregas o preguntas frecuentes (publicado)' },
      { key: 'ai_provider', label: 'Clave del modelo de IA en el servidor', done: aiProvider, required: false, hint: aiProvider ? '' : 'Falta la clave de Gemini (de la plataforma o propia en Integraciones): sin ella los mensajes los atiende el equipo' },
    );
  }
  return {
    status: t.status,
    activatedAt: t.activatedAt,
    tasks,
    canActivate: t.status === 'ONBOARDING' && tasks.every((x) => !x.required || x.done),
  };
}
