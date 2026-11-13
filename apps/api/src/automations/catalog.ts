import { z } from 'zod';
import type { AutomationKey } from '../generated/prisma/enums.js';
import type { ModuleKey } from '../common/decorators/module.decorator.js';
import { FEATURES } from '../plans/plan-limits.js';

/**
 * Catálogo de automatizaciones (ADR 040). La empresa activa y configura; nunca
 * edita los flujos. Las que tocan pedidos o escriben al cliente las ejecuta el
 * backend; n8n solo hace avisos secundarios (correo al equipo) y nunca escribe
 * en la base de datos.
 */
export type Executor = 'n8n' | 'backend';

export interface ConfigField {
  key: string;
  label: string;
  type: 'number' | 'multiselect' | 'templates';
  help?: string;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

export interface CatalogEntry {
  key: AutomationKey;
  name: string;
  description: string;
  executor: Executor;
  /** A quién llega el resultado */
  audience: 'equipo' | 'cliente';
  module: ModuleKey;
  /** Función del plan necesaria para activarla */
  feature?: string;
  /** Activada al crear una empresa nueva */
  defaultEnabled: boolean;
  version: number;
  /** Qué cambió en cada versión (se muestra antes de aplicarla) */
  changelog: Record<number, string>;
  /** Ruta del webhook de n8n y archivo del flujo importable */
  n8nPath?: string;
  workflowFile?: string;
  schema: z.ZodType<Record<string, unknown>>;
  defaults: Record<string, unknown>;
  fields: ConfigField[];
}

const STATUS_LABEL: Record<string, string> = { CONFIRMED: 'Confirmado', PREPARING: 'En preparación', SHIPPED: 'Enviado', DELIVERED: 'Entregado', CANCELLED: 'Anulado' };
export const NOTIFIABLE_STATUSES = ['CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
type NotifiableStatus = (typeof NOTIFIABLE_STATUSES)[number];

const template = z.string().trim().min(5).max(500);
export const ORDER_STATUS_DEFAULT_TEMPLATES: Record<NotifiableStatus, string> = {
  CONFIRMED: 'Hola {cliente}, confirmamos tu pedido #{numero} por {total}. ¡Gracias por tu compra!',
  PREPARING: 'Hola {cliente}, estamos preparando tu pedido #{numero}.',
  SHIPPED: 'Hola {cliente}, tu pedido #{numero} ya está en camino.',
  DELIVERED: 'Hola {cliente}, tu pedido #{numero} fue entregado. ¡Gracias por elegirnos!',
  CANCELLED: 'Hola {cliente}, tu pedido #{numero} fue anulado. Si tienes dudas, escríbenos por aquí.',
};

export const CATALOG: CatalogEntry[] = [
  {
    key: 'NEW_ORDER_NOTIFICATION', name: 'Aviso de pedido nuevo', executor: 'n8n', audience: 'equipo', module: 'orders', defaultEnabled: true,
    description: 'Envía un correo a los administradores cada vez que entra un pedido.',
    version: 2, changelog: { 1: 'Correo por cada pedido nuevo.', 2: 'Permite elegir los canales (WhatsApp o panel) y un importe mínimo.' },
    n8nPath: 'aisa-pedido-nuevo', workflowFile: '03-aisa-pedido-nuevo.json',
    schema: z.object({ channels: z.array(z.enum(['WHATSAPP', 'MANUAL'])).min(1), minTotal: z.number().min(0).max(1_000_000) }).strict(),
    defaults: { channels: ['WHATSAPP', 'MANUAL'], minTotal: 0 },
    fields: [
      { key: 'channels', label: 'Canales', type: 'multiselect', options: [{ value: 'WHATSAPP', label: 'Pedidos por WhatsApp' }, { value: 'MANUAL', label: 'Pedidos creados en el panel' }] },
      { key: 'minTotal', label: 'Importe mínimo', type: 'number', min: 0, max: 1_000_000, help: '0 = todos los pedidos' },
    ],
  },
  {
    key: 'LOW_STOCK_ALERT', name: 'Alerta de stock bajo', executor: 'n8n', audience: 'equipo', module: 'inventory', defaultEnabled: true,
    description: 'Envía un correo cuando un producto baja de su stock mínimo (una vez por cruce del umbral).',
    version: 1, changelog: { 1: 'Correo al cruzar el mínimo de cada producto.' },
    n8nPath: 'aisa-stock-bajo', workflowFile: '04-aisa-stock-bajo.json',
    schema: z.object({}).strict(), defaults: {}, fields: [],
  },
  {
    key: 'HANDOFF_NOTIFICATION', name: 'Aviso de derivación a una persona', executor: 'n8n', audience: 'equipo', module: 'conversations', defaultEnabled: false,
    description: 'Envía un correo a los administradores cuando el asistente pasa una conversación a una persona. El aviso en el panel llega siempre.',
    version: 1, changelog: { 1: 'Correo con el cliente, el motivo y el enlace a la conversación.' },
    n8nPath: 'aisa-derivacion', workflowFile: '06-aisa-derivacion.json',
    schema: z.object({}).strict(), defaults: {}, fields: [],
  },
  {
    key: 'ERROR_ALERT', name: 'Alerta de errores de WhatsApp', executor: 'n8n', audience: 'equipo', module: 'conversations', defaultEnabled: true,
    description: 'Envía un correo cuando un mensaje no se pudo entregar o el token de WhatsApp dejó de ser válido.',
    version: 1, changelog: { 1: 'Correo por mensajes no entregados y token caducado.' },
    n8nPath: 'aisa-error', workflowFile: '07-aisa-error.json',
    schema: z.object({}).strict(), defaults: {}, fields: [],
  },
  {
    key: 'ORDER_STATUS_NOTIFICATION', name: 'Estado del pedido al cliente', executor: 'backend', audience: 'cliente', module: 'orders', feature: FEATURES.ADVANCED_AUTOMATIONS, defaultEnabled: false,
    description: 'Escribe al cliente por WhatsApp cuando su pedido cambia de estado. Solo pedidos que llegaron por WhatsApp y dentro de la ventana de 24 h que exige Meta; fuera de ella se registra como omitido.',
    version: 1, changelog: { 1: 'Mensaje por WhatsApp en los estados elegidos, con textos editables.' },
    schema: z.object({
      statuses: z.array(z.enum(NOTIFIABLE_STATUSES)).min(1),
      templates: z.object(Object.fromEntries(NOTIFIABLE_STATUSES.map((s) => [s, template])) as Record<NotifiableStatus, typeof template>).strict(),
    }).strict(),
    defaults: { statuses: ['CONFIRMED', 'SHIPPED', 'DELIVERED'], templates: ORDER_STATUS_DEFAULT_TEMPLATES },
    fields: [
      { key: 'statuses', label: 'Avisar cuando el pedido pase a', type: 'multiselect', options: NOTIFIABLE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s]! })) },
      { key: 'templates', label: 'Textos', type: 'templates', options: NOTIFIABLE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s]! })), help: 'Puedes usar {cliente}, {numero}, {total} y {empresa}.' },
    ],
  },
  {
    key: 'PENDING_ORDER_REMINDER', name: 'Recordatorio de pedidos sin confirmar', executor: 'backend', audience: 'equipo', module: 'orders', feature: FEATURES.ADVANCED_AUTOMATIONS, defaultEnabled: false,
    description: 'Crea un aviso en el panel cuando un pedido sigue pendiente después de las horas indicadas (uno por pedido).',
    version: 1, changelog: { 1: 'Aviso en el panel por pedido pendiente.' },
    schema: z.object({ hours: z.number().int().min(1).max(72) }).strict(),
    defaults: { hours: 4 },
    fields: [{ key: 'hours', label: 'Horas sin confirmar', type: 'number', min: 1, max: 72 }],
  },
  {
    key: 'RESERVATION_REMINDER', name: 'Recordatorio de reserva al cliente', executor: 'backend', audience: 'cliente', module: 'reservations', defaultEnabled: false,
    description: 'Escribe al cliente por WhatsApp unas horas antes de su reserva o cita confirmada. Solo reservas que llegaron por WhatsApp y dentro de la ventana de 24 h de Meta; fuera de ella se registra como omitido.',
    version: 1, changelog: { 1: 'Mensaje por WhatsApp antes de la reserva, con texto editable.' },
    schema: z.object({ hoursBefore: z.number().int().min(1).max(23), templates: z.object({ REMINDER: template }).strict() }).strict(),
    defaults: { hoursBefore: 3, templates: { REMINDER: 'Hola {cliente}, te recordamos tu reserva #{numero} en {empresa} hoy {fecha} a las {hora}. Si no puedes venir, avísanos por aquí.' } },
    fields: [
      { key: 'hoursBefore', label: 'Horas antes', type: 'number', min: 1, max: 23, help: 'Menos de 24 h: WhatsApp solo deja escribir dentro de las 24 h del último mensaje del cliente.' },
      { key: 'templates', label: 'Texto', type: 'templates', options: [{ value: 'REMINDER', label: 'Recordatorio' }], help: 'Puedes usar {cliente}, {numero}, {fecha}, {hora}, {personas}, {servicio} y {empresa}.' },
    ],
  },
];

export const catalogEntry = (key: AutomationKey) => CATALOG.find((e) => e.key === key);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Combina dos configuraciones: lo de `patch` manda; los objetos anidados (textos) se combinan por clave. */
export function mergeConfig(base: unknown, patch: unknown): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(isObject(base) ? base : {}) };
  for (const [k, v] of Object.entries(isObject(patch) ? patch : {})) {
    const d = merged[k];
    merged[k] = isObject(d) && isObject(v) ? { ...d, ...v } : v;
  }
  return merged;
}

/** Configuración efectiva: lo guardado por la empresa manda; lo que falte toma el valor del catálogo. */
export function effectiveConfig(entry: CatalogEntry, stored: unknown): Record<string, unknown> {
  return mergeConfig(entry.defaults, stored);
}

/** Rellena {marcadores} con datos del pedido (el texto lo escribe la empresa, no el cliente). */
export function fillTemplate(text: string, vars: Record<string, string>) {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}
