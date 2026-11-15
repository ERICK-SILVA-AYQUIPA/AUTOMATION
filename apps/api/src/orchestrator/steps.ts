import type { ProvisioningStatus } from '../generated/prisma/enums.js';

/**
 * Pasos del orquestador (ADR 051), en orden. Cada uno tiene un plazo (si se
 * supera, la ejecución pasa a «Requiere intervención») y, los que ejecuta la
 * plataforma, un máximo de intentos ante fallos temporales.
 */
export const FLOW: ProvisioningStatus[] = [
  'REQUESTED', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'PREPARING', 'CREATING_INFRA', 'SERVER_READY',
  'CONFIGURING_SERVER', 'INSTALLING', 'MIGRATING', 'CONFIGURING_INTEGRATIONS', 'TESTING', 'PUBLISHING', 'DELIVERING',
];
export const FINAL: ProvisioningStatus[] = ['DELIVERED', 'CANCELLED'];
export const STOPPED: ProvisioningStatus[] = ['ERROR', 'NEEDS_INTERVENTION'];
/** Pasos que informa el agente que corre en el servidor nuevo */
export const AGENT_STEPS: ProvisioningStatus[] = ['CONFIGURING_SERVER', 'INSTALLING', 'MIGRATING', 'CONFIGURING_INTEGRATIONS'];

export const LABEL: Record<ProvisioningStatus, string> = {
  REQUESTED: 'Solicitud creada',
  PAYMENT_PENDING: 'Pago pendiente',
  PAYMENT_CONFIRMED: 'Pago confirmado',
  PREPARING: 'Preparando instalación',
  CREATING_INFRA: 'Creando infraestructura',
  SERVER_READY: 'Servidor disponible',
  CONFIGURING_SERVER: 'Configurando servidor',
  INSTALLING: 'Instalando servicios',
  MIGRATING: 'Migrando base de datos',
  CONFIGURING_INTEGRATIONS: 'Configurando integraciones',
  TESTING: 'Ejecutando pruebas',
  PUBLISHING: 'Publicando',
  DELIVERING: 'Entregando',
  DELIVERED: 'Entregada',
  ERROR: 'Error',
  CANCELLED: 'Cancelada',
  NEEDS_INTERVENTION: 'Requiere intervención',
};

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Plazo máximo en cada paso desde que empezó */
export const DEADLINE: Partial<Record<ProvisioningStatus, number>> = {
  PAYMENT_PENDING: 14 * 24 * HOUR,
  PREPARING: 30 * MIN,
  // Incluye esperar la aprobación del servidor (una persona autoriza el gasto)
  CREATING_INFRA: 3 * 24 * HOUR,
  SERVER_READY: 30 * MIN,
  // Desde que el servidor arranca: cloud-init, Docker y el kit
  CONFIGURING_SERVER: 40 * MIN,
  INSTALLING: 60 * MIN,
  MIGRATING: 20 * MIN,
  CONFIGURING_INTEGRATIONS: 20 * MIN,
  // DNS y certificado pueden tardar: hasta 2 h de comprobaciones
  TESTING: 2 * HOUR,
  PUBLISHING: 30 * MIN,
  DELIVERING: 30 * MIN,
};
/** Intentos ante fallos temporales en los pasos que ejecuta la plataforma */
export const MAX_ATTEMPTS: Partial<Record<ProvisioningStatus, number>> = {
  REQUESTED: 5, PAYMENT_PENDING: 5, PAYMENT_CONFIRMED: 5, PREPARING: 5, CREATING_INFRA: 6, SERVER_READY: 6,
  TESTING: 40, PUBLISHING: 15, DELIVERING: 5,
};
/** Espera entre consultas mientras un paso espera algo externo */
export const POLL: Partial<Record<ProvisioningStatus, number>> = {
  PAYMENT_PENDING: 5 * MIN, CREATING_INFRA: 30_000, SERVER_READY: 15_000,
  CONFIGURING_SERVER: MIN, INSTALLING: MIN, MIGRATING: MIN, CONFIGURING_INTEGRATIONS: MIN,
};

/** Espera tras el intento n (1, 2, 3…): exponencial desde 30 s con tope de 5 min */
export const backoff = (attempt: number) => Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 5 * MIN);

export const nextOf = (s: ProvisioningStatus): ProvisioningStatus => {
  const i = FLOW.indexOf(s);
  if (i < 0) throw new Error(`Paso sin siguiente: ${s}`);
  return i === FLOW.length - 1 ? 'DELIVERED' : FLOW[i + 1];
};
export const isActive = (s: ProvisioningStatus) => FLOW.includes(s);

/** Qué hace el paso con un informe del agente: avanzar, ignorarlo (repetido) o rechazarlo */
export function agentReport(current: ProvisioningStatus, step: ProvisioningStatus): 'advance' | 'ignore' | 'reject' {
  const ci = FLOW.indexOf(current);
  const si = FLOW.indexOf(step);
  if (!AGENT_STEPS.includes(step) || ci < 0) return 'reject';
  if (si < ci) return 'ignore';
  // El agente informa en orden; aceptamos que salte pasos que ya hizo si los informes se cruzan
  if (current === 'SERVER_READY' || current === 'CREATING_INFRA' || AGENT_STEPS.includes(current)) return 'advance';
  return 'reject';
}

/** Nombre válido de servidor a partir del dominio (Hetzner: RFC 1123, máx. 63) */
export function serverNameFor(domain: string, runNumber: number) {
  const base = domain.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return `aisa-${runNumber}-${base}`.slice(0, 63).replace(/-+$/, '');
}

/** Texto de un informe externo: sin caracteres de control y con largo acotado */
export const cleanText = (s: string, max = 2000) => {
  let out = '';
  for (const ch of s) {
    const n = ch.codePointAt(0)!;
    if (n === 9 || n === 10 || n === 13 || (n >= 32 && n !== 127)) out += ch;
  }
  return out.slice(0, max);
};
