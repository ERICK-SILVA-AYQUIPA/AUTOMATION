'use client';

import type { Tone } from '../infraestructura/shared';

export const installNo = (n: number) => `OI-${String(n).padStart(5, '0')}`;

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  REQUESTED: { label: 'Solicitud creada', tone: 'neutral' },
  PAYMENT_PENDING: { label: 'Pago pendiente', tone: 'warning' },
  PAYMENT_CONFIRMED: { label: 'Pago confirmado', tone: 'info' },
  PREPARING: { label: 'Preparando instalación', tone: 'info' },
  CREATING_INFRA: { label: 'Creando infraestructura', tone: 'info' },
  SERVER_READY: { label: 'Servidor disponible', tone: 'info' },
  CONFIGURING_SERVER: { label: 'Configurando servidor', tone: 'info' },
  INSTALLING: { label: 'Instalando servicios', tone: 'info' },
  MIGRATING: { label: 'Migrando base de datos', tone: 'info' },
  CONFIGURING_INTEGRATIONS: { label: 'Configurando integraciones', tone: 'info' },
  TESTING: { label: 'Ejecutando pruebas', tone: 'info' },
  PUBLISHING: { label: 'Publicando', tone: 'info' },
  DELIVERING: { label: 'Entregando', tone: 'info' },
  DELIVERED: { label: 'Entregada', tone: 'success' },
  ERROR: { label: 'Error', tone: 'danger' },
  CANCELLED: { label: 'Cancelada', tone: 'neutral' },
  NEEDS_INTERVENTION: { label: 'Requiere intervención', tone: 'danger' },
};
export const ACTIVE = ['REQUESTED', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'PREPARING', 'CREATING_INFRA', 'SERVER_READY', 'CONFIGURING_SERVER', 'INSTALLING', 'MIGRATING', 'CONFIGURING_INTEGRATIONS', 'TESTING', 'PUBLISHING', 'DELIVERING'];

export interface RunRow {
  id: string; number: number; domain: string; adminEmail: string; serverType: string; location: string; status: string; stoppedAt: string | null; attempts: number;
  lastError: string | null; needs: string | null; createdAt: string; finishedAt: string | null; stepStartedAt: string;
  installationOrder: { number: number; lead: { name: string; company: string | null } };
  server: { name: string; ipv4: string | null; status: string; deletedAt: string | null } | null;
  lastReportAt: string | null; lastReport: InstanceReport | null; reportAlertedAt: string | null;
}

/** Reporte periódico de una instalación entregada (ADR 052): estados y conteos, sin datos de clientes */
export interface InstanceReport {
  version: string; at: string; healthy: boolean;
  tenants: {
    name: string; status: string; activeProducts: number; enabledAutomations: number;
    integrations: { key: 'whatsapp' | 'ai' | 'email' | 'automations'; status: 'connected' | 'error' | 'not_configured' | 'pending' | 'managed'; detail: string }[];
    tasks: { key: string; label: string; done: boolean; required: boolean }[];
  }[];
}
export const INTEGRATION_LABEL = { whatsapp: 'WhatsApp', ai: 'IA (asistente)', email: 'Correo', automations: 'Automatizaciones' } as const;
export const INTEGRATION_STATE: Record<string, { label: string; tone: Tone }> = {
  connected: { label: 'Conectado', tone: 'success' }, managed: { label: 'Gestionado', tone: 'success' }, pending: { label: 'Pendiente de prueba', tone: 'warning' },
  not_configured: { label: 'Sin configurar', tone: 'neutral' }, error: { label: 'Con error', tone: 'danger' },
};
/** Sin reporte en 30 minutos se considera silenciosa (cada 10 debería reportar) */
export const STALE_MS = 30 * 60_000;
export function monitorState(r: Pick<RunRow, 'status' | 'lastReportAt' | 'lastReport'>, now = Date.now()): { label: string; tone: Tone } | null {
  if (r.status !== 'DELIVERED') return null;
  if (!r.lastReportAt || !r.lastReport) return { label: 'Sin reportes', tone: 'warning' };
  if (now - new Date(r.lastReportAt).getTime() > STALE_MS) return { label: 'No reporta', tone: 'danger' };
  if (!r.lastReport.healthy) return { label: 'Servicios con problemas', tone: 'danger' };
  const pending = r.lastReport.tenants.reduce((n, t) => n + t.tasks.filter((k) => k.required && !k.done).length, 0);
  return pending ? { label: `Puesta en marcha: faltan ${pending}`, tone: 'warning' } : { label: 'En marcha', tone: 'success' };
}
export interface RunDetail extends Omit<RunRow, 'installationOrder'> {
  settings: { systemName: string; supportContact: string; deliveryId?: string; smtp: { host: string; port: number; secure: boolean; user: string; from: string } };
  stepDeadlineAt: string | null; nextRunAt: string | null; bootstrapUsedAt: string | null; agentSeenAt: string | null; cancelReason: string | null; alertedAt: string | null;
  installationOrder: { id: string; number: number; status: string; tenant: { id: string; name: string } | null; lead: { id: string; name: string; company: string | null } };
  provider: { id: string; label: string; kind: string };
  serverRequest: { id: string; number: number; status: string; name: string; priceMonthly: string; currency: string; error: string | null; decisionNote: string | null } | null;
  server: { id: string; name: string; ipv4: string | null; ipv6: string | null; status: string; deletedAt: string | null } | null;
  events: { id: string; status: string; level: 'info' | 'warn' | 'error'; message: string; source: 'engine' | 'user' | 'agent'; createdAt: string }[];
  flow: string[];
  monitoring: boolean;
}
