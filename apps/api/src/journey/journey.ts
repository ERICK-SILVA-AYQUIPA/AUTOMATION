import type { InstanceReport } from '../orchestrator/instance-status.js';
import { LABEL } from '../orchestrator/steps.js';
import { installNo, orderNo, quoteNo } from '../quotes/quote-pdf.js';

/**
 * Asistente «Nueva venta e instalación» (ADR 053): los 12 pasos de la
 * especificación (§14) calculados con los datos reales del prospecto, sus
 * cotizaciones, pagos, orden de instalación, empresa e instalación. Nada se
 * marca a mano: cada paso dice qué falta y dónde se hace.
 */
export type StepState = 'done' | 'current' | 'pending' | 'blocked' | 'skipped';
export interface JourneyStep { n: number; key: string; title: string; state: StepState; detail: string; missing: string[]; action: { label: string; href: string } | null }

type Mode = 'SAAS' | 'DEDICATED' | 'CUSTOM';
export interface JourneyData {
  lead: { id: string; number: number; name: string; company: string | null; email: string | null; status: string; interestPlan: string | null; interestMode: Mode | null; interestModules: string[]; tenantId: string | null };
  quote: { id: string; number: number; status: string; planCode: string | null; deploymentMode: Mode | null; modules: string[] } | null;
  payment: { id: string; number: number; status: string } | null;
  installation: { id: string; number: number; status: string; deploymentMode: Mode | null } | null;
  tenant: { id: string; name: string; status: string; deploymentMode: Mode } | null;
  /** Lista de puesta en marcha de la empresa en la plataforma (SaaS) */
  onboarding: { key: string; label: string; done: boolean; required: boolean }[] | null;
  run: {
    id: string; number: number; status: string; stoppedAt: string | null; lastError: string | null; needs: string | null; domain: string;
    serverRequest: { number: number; status: string } | null; server: { name: string; ipv4: string | null; deletedAt: Date | null } | null;
    lastReport: InstanceReport | null; lastReportAt: Date | null;
  } | null;
}

const AFTER_DEPLOY = ['TESTING', 'PUBLISHING', 'DELIVERING', 'DELIVERED'];
const AFTER_SERVER = ['SERVER_READY', 'CONFIGURING_SERVER', 'INSTALLING', 'MIGRATING', 'CONFIGURING_INTEGRATIONS', ...AFTER_DEPLOY];
const PLAN: Record<string, string> = { BASIC: 'Básico', PROFESSIONAL: 'Profesional', ENTERPRISE: 'Empresarial' };
const MODULE: Record<string, string> = {
  conversations: 'Conversaciones', ai: 'Asistente IA', catalog: 'Productos y categorías', inventory: 'Inventario', orders: 'Pedidos',
  customers: 'Clientes', reports: 'Reportes', automations: 'Automatizaciones', reservations: 'Reservas y citas',
};
const MODE: Record<Mode, string> = { SAAS: 'SaaS (en la plataforma)', DEDICATED: 'Instancia dedicada', CUSTOM: 'Instalación a medida' };

export function buildJourney(d: JourneyData): { steps: JourneyStep[]; current: number; mode: Mode | null; done: number } {
  const { lead, quote, payment, installation, tenant, run } = d;
  const plan = quote?.planCode ?? lead.interestPlan;
  const mode: Mode | null = installation?.deploymentMode ?? quote?.deploymentMode ?? tenant?.deploymentMode ?? lead.interestMode;
  const modules = quote?.modules.length ? quote.modules : lead.interestModules;
  const saas = mode === 'SAAS';
  const leadHref = `/plataforma/ventas/${lead.id}`;
  const newQuote = `/plataforma/cotizaciones/nueva?lead=${lead.id}`;
  const quoteHref = quote ? `/plataforma/cotizaciones/${quote.id}` : newQuote;
  const runHref = run ? `/plataforma/aprovisionamiento/${run.id}` : installation ? `/plataforma/aprovisionamiento?orden=${installation.id}` : '/plataforma/aprovisionamiento';
  const live = run && run.status !== 'CANCELLED' ? run : null;
  const paidDirect = !quote && payment?.status === 'PAID'; // venta directa registrada en el prospecto, sin cotización
  const accepted = quote?.status === 'ACCEPTED' || paidDirect;
  const paid = payment?.status === 'PAID';
  const delivered = saas ? tenant?.status === 'ACTIVE' : live?.status === 'DELIVERED';

  // Puesta en marcha de WhatsApp e IA: la calcula la instalación (dedicada) o la plataforma (SaaS)
  const report = live?.lastReport?.tenants.find((t) => t.name === tenant?.name) ?? live?.lastReport?.tenants[0] ?? null;
  const tasks = saas ? d.onboarding : report?.tasks ?? null;
  const wa = tasks?.filter((t) => t.key.startsWith('whatsapp')) ?? [];
  const ai = saas ? d.onboarding?.find((t) => t.key === 'ai_provider') : null;
  const aiState = report?.integrations.find((i) => i.key === 'ai');
  const aiOk = saas ? !!ai?.done : aiState?.status === 'connected';
  const waOk = wa.length > 0 && wa.every((t) => t.done);

  const steps: Omit<JourneyStep, 'n'>[] = [
    { key: 'client', title: 'Seleccionar o registrar cliente', state: 'done', detail: `${lead.company ?? lead.name}${lead.email ? ` · ${lead.email}` : ''}`, missing: lead.email ? [] : ['Correo del contacto (lo necesita la cotización y la entrega)'], action: { label: 'Ver prospecto', href: leadHref } },
    { key: 'plan', title: 'Seleccionar producto y plan', state: plan ? 'done' : 'pending', detail: plan ? `Plan ${PLAN[plan] ?? plan}` : 'Sin plan elegido', missing: plan ? [] : ['Plan de interés en el prospecto o en la cotización'], action: { label: plan ? 'Cambiar en el prospecto' : 'Elegir plan', href: leadHref } },
    { key: 'mode', title: 'Elegir modalidad de instalación', state: mode ? 'done' : 'pending', detail: mode ? MODE[mode] : 'Sin modalidad', missing: mode ? [] : ['Modalidad: SaaS, instancia dedicada o a medida'], action: { label: 'Elegir en el prospecto', href: leadHref } },
    { key: 'modules', title: 'Configurar servicios y módulos', state: modules.length ? 'done' : 'pending', detail: modules.length ? `${modules.length} módulo(s): ${modules.map((m) => MODULE[m] ?? m).join(', ')}` : 'Sin módulos elegidos', missing: modules.length ? [] : ['Módulos de interés o en la cotización'], action: { label: 'Elegir en el prospecto', href: leadHref } },
    {
      key: 'quote', title: 'Generar cotización', state: quote && quote.status !== 'DRAFT' ? 'done' : 'pending',
      detail: quote ? `${quoteNo(quote.number)}: ${quoteStatus(quote.status)}` : 'Sin cotización',
      missing: !quote ? ['Crear la cotización con precios del catálogo'] : quote.status === 'DRAFT' ? ['Enviar la cotización al cliente'] : [],
      action: { label: quote ? 'Abrir cotización' : 'Nueva cotización', href: quoteHref },
    },
    {
      key: 'payment', title: 'Confirmar contratación y pago', state: accepted && paid ? 'done' : 'pending',
      detail: [quote ? (accepted ? 'Cotización aceptada por el cliente' : 'El cliente aún no acepta la cotización') : paidDirect ? 'Venta directa sin cotización' : null, payment ? `${orderNo(payment.number)}: ${paymentStatus(payment.status)}` : 'Sin orden de pago'].filter(Boolean).join(' · '),
      missing: [...(accepted ? [] : ['Aceptación del cliente en el enlace de la cotización']), ...(payment?.status === 'PROOF_SUBMITTED' ? ['Validar el comprobante contra la cuenta (el comprobante solo no prueba el pago)'] : paid ? [] : ['Pago recibido y validado'])],
      action: payment ? { label: payment.status === 'PROOF_SUBMITTED' ? 'Validar pago' : 'Ver orden de pago', href: `/plataforma/cotizaciones/pagos/${payment.id}` } : { label: 'Abrir cotización', href: quoteHref },
    },
    {
      key: 'approve', title: 'Aprobar aprovisionamiento', state: (saas ? !!tenant : !!live && !!tenant) ? 'done' : 'pending',
      detail: [installation ? `Orden de instalación ${installNo(installation.number)}` : 'Sin orden de instalación (se crea al validar el pago)', tenant ? `empresa ${tenant.name}` : 'sin empresa creada', !saas && live ? `instalación #${live.number}` : null].filter(Boolean).join(' · '),
      missing: [...(installation ? [] : ['Orden de instalación']), ...(tenant ? [] : ['Convertir el prospecto en empresa (asistente de alta)']), ...(!saas && !live ? ['Registrar la instalación automática (dominio, región, tamaño, SMTP)'] : [])],
      action: !tenant ? { label: 'Convertir en empresa', href: `/plataforma/nueva?lead=${lead.id}` } : !saas ? { label: live ? 'Ver instalación' : 'Registrar instalación', href: runHref } : null,
    },
    saas
      ? { key: 'server', title: 'Crear servidor o conectar servidor existente', state: 'skipped', detail: 'SaaS: la empresa vive en la plataforma central, no necesita servidor', missing: [], action: null }
      : {
          key: 'server', title: 'Crear servidor o conectar servidor existente', state: live && AFTER_SERVER.includes(live.stoppedAt ?? live.status) ? 'done' : 'pending',
          detail: live?.server ? `${live.server.name}${live.server.ipv4 ? ` · ${live.server.ipv4}` : ''}${live.server.deletedAt ? ' (eliminado)' : ''}` : live?.serverRequest ? `Solicitud de servidor #${live.serverRequest.number}: ${live.serverRequest.status === 'PENDING_APPROVAL' ? 'espera tu aprobación' : live.serverRequest.status.toLowerCase()}` : 'Sin servidor',
          missing: live?.serverRequest?.status === 'PENDING_APPROVAL' ? ['Aprobar el gasto del servidor en Infraestructura'] : live?.server ? [] : ['La instalación pide el servidor al proveedor conectado'],
          action: live?.serverRequest?.status === 'PENDING_APPROVAL' ? { label: 'Aprobar en Infraestructura', href: '/plataforma/infraestructura?tab=solicitudes' } : live ? { label: 'Ver instalación', href: runHref } : null,
        },
    saas
      ? { key: 'deploy', title: 'Desplegar y configurar el sistema', state: tenant ? 'done' : 'pending', detail: tenant ? 'Empresa creada en la plataforma con su plantilla y módulos' : 'Se configura al crear la empresa', missing: tenant ? [] : ['Crear la empresa'], action: tenant ? null : { label: 'Convertir en empresa', href: `/plataforma/nueva?lead=${lead.id}` } }
      : {
          key: 'deploy', title: 'Desplegar y configurar el sistema', state: live && AFTER_DEPLOY.includes(live.stoppedAt ?? live.status) ? 'done' : 'pending',
          detail: live ? `${LABEL[(live.stoppedAt ?? live.status) as keyof typeof LABEL] ?? live.status}${live.stoppedAt ? ` (detenida: ${live.lastError ?? ''})` : ''}` : 'Sin instalación',
          missing: live?.stoppedAt ? [live.needs ?? 'Revisar y reintentar'] : live && ['SERVER_READY', 'CONFIGURING_SERVER'].includes(live.status) && live.server?.ipv4 ? [`Registro DNS A: ${live.domain} → ${live.server.ipv4}`] : [],
          action: live ? { label: 'Ver instalación', href: runHref } : null,
        },
    {
      key: 'connect', title: 'Conectar WhatsApp y Gemini', state: waOk && aiOk ? 'done' : 'pending',
      detail: tasks ? `WhatsApp: ${waOk ? 'credenciales verificadas y webhook recibido' : 'pendiente'} · IA: ${aiOk ? 'lista' : saas ? 'falta la clave del modelo' : aiState ? aiStateText(aiState.status) : 'sin reporte'}` : saas ? 'Se ve al crear la empresa' : 'Se ve cuando la instalación reporta (cada 10 minutos)',
      missing: [...wa.filter((t) => !t.done).map((t) => t.label), ...(aiOk || !tasks ? [] : ['IA conectada y probada (clave de Gemini u otro proveedor en Integraciones)'])],
      action: tenant ? (saas ? { label: 'Ver ficha de la empresa', href: `/plataforma?empresa=${tenant.id}` } : live ? { label: 'Ver monitoreo', href: runHref } : null) : null,
    },
    saas
      ? { key: 'tests', title: 'Ejecutar pruebas', state: d.onboarding?.every((t) => !t.required || t.done) ? 'done' : 'pending', detail: 'Lista de puesta en marcha con pruebas reales (credenciales, webhook, periodo vigente, administrador)', missing: d.onboarding?.filter((t) => t.required && !t.done).map((t) => t.label) ?? ['Crear la empresa'], action: tenant ? { label: 'Ver ficha de la empresa', href: `/plataforma?empresa=${tenant.id}` } : null }
      : {
          key: 'tests', title: 'Ejecutar pruebas', state: live && ['PUBLISHING', 'DELIVERING', 'DELIVERED'].includes(live.status) ? 'done' : 'pending',
          detail: live?.status === 'TESTING' ? `Comprobando desde afuera DNS, HTTPS y salud${live.lastError ? `: ${live.lastError}` : ''}` : 'DNS, HTTPS con certificado válido, salud de la API y panel publicado',
          missing: live?.stoppedAt === 'TESTING' ? [live.needs ?? 'Revisar y reintentar'] : [], action: live ? { label: 'Ver instalación', href: runHref } : null,
        },
    {
      key: 'deliver', title: 'Publicar y entregar', state: delivered ? 'done' : 'pending',
      detail: delivered ? (saas ? `Empresa ${tenant!.name} activa` : `Entregada en https://${live!.domain}`) : saas ? 'Se activa cuando la puesta en marcha está completa' : 'Correo de entrega al administrador al terminar',
      missing: delivered ? [] : saas ? ['Activar la empresa desde su ficha'] : [], action: saas && tenant ? { label: 'Ver ficha de la empresa', href: `/plataforma?empresa=${tenant.id}` } : live ? { label: 'Ver instalación', href: runHref } : null,
    },
  ];
  // El paso actual es el primero sin hacer; los siguientes quedan bloqueados mientras falte algo antes del pago
  const firstOpen = steps.findIndex((s) => s.state === 'pending');
  const out = steps.map((s, i) => ({
    ...s, n: i + 1,
    state: (s.state === 'pending' ? (i === firstOpen ? 'current' : firstOpen >= 0 && firstOpen <= 5 && i > 5 ? 'blocked' : 'pending') : s.state) as StepState,
  }));
  return { steps: out, current: firstOpen < 0 ? steps.length : firstOpen + 1, mode, done: out.filter((s) => s.state === 'done' || s.state === 'skipped').length };
}

function quoteStatus(s: string) {
  return ({ DRAFT: 'borrador', SENT: 'enviada', ACCEPTED: 'aceptada', REJECTED: 'rechazada', EXPIRED: 'vencida', CANCELLED: 'anulada' } as Record<string, string>)[s] ?? s;
}
function paymentStatus(s: string) {
  return ({ PENDING: 'pendiente de pago', PROOF_SUBMITTED: 'comprobante por validar', PAID: 'pagada y validada', CANCELLED: 'anulada' } as Record<string, string>)[s] ?? s;
}
function aiStateText(s: string) {
  return ({ connected: 'conectada', error: 'con error', not_configured: 'sin configurar', pending: 'sin probar', managed: 'gestionada' } as Record<string, string>)[s] ?? s;
}
