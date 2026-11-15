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
}
