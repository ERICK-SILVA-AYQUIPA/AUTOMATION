import type { AiProfile } from '../ai/ai-profile.js';
import type { ModuleKey } from '../common/decorators/module.decorator.js';
import type { AutomationKey, BusinessType } from '../generated/prisma/enums.js';
import type { TenantSettings } from '../tenants/tenant-settings.js';

/**
 * Plantillas por sector (ADR 043). No son sistemas aparte: todas usan los
 * mismos módulos y solo cambian qué se enciende y con qué reglas. Nada de
 * esto es dato comercial inventado: capacidad, horario de reservas, pedido
 * mínimo y precios los define la empresa; la plantilla solo deja el campo
 * preparado y la lista de puesta en marcha avisa si falta.
 */
export type TemplateKey = 'RETAIL' | 'RESTAURANT' | 'DISTRIBUTOR' | 'SERVICES';
type DeepPartialSettings = { [K in keyof TenantSettings]?: Partial<TenantSettings[K]> };

export interface SectorTemplate {
  key: TemplateKey;
  version: number;
  name: string;
  description: string;
  businessType: BusinessType;
  /** Qué deja preparado (se muestra al elegirla) */
  includes: string[];
  modules: ModuleKey[];
  settings: DeepPartialSettings;
  /** Estado de cada automatización (las que no aparecen no se tocan) */
  automations: Partial<Record<AutomationKey, boolean>>;
  /** Campos del asistente (van al borrador si la empresa ya existe) */
  ai: Partial<Pick<AiProfile, 'qualifyingQuestions' | 'extraInstructions'>>;
  /** Categorías sugeridas: solo se crean si se eligen y no existen */
  categories: string[];
}

const BASE: ModuleKey[] = ['conversations', 'ai', 'catalog', 'customers', 'reports', 'automations'];

export const TEMPLATES: Record<TemplateKey, SectorTemplate> = {
  RETAIL: {
    key: 'RETAIL', version: 1, name: 'Tienda comercial', businessType: 'RETAIL',
    description: 'Catálogo con variantes, precios, inventario por sucursal, pedidos y consultas por WhatsApp.',
    includes: ['Catálogo con variantes (talla, color, presentación)', 'Inventario con alerta de stock bajo', 'Pedidos desde WhatsApp y el panel', 'Aviso por correo de cada pedido nuevo'],
    modules: [...BASE, 'inventory', 'orders'],
    settings: { catalog: { label: 'Productos', trackStockDefault: true, volumePricing: false, durations: false }, customers: { businessFields: false } },
    automations: { NEW_ORDER_NOTIFICATION: true, LOW_STOCK_ALERT: true, ERROR_ALERT: true, RESERVATION_REMINDER: false },
    ai: {
      qualifyingQuestions: ['¿Qué características buscas (talla, color, presentación)?'],
      extraInstructions: 'Si un producto tiene variantes, confirma cuál prefiere el cliente antes de registrar el pedido.',
    },
    categories: [],
  },
  RESTAURANT: {
    key: 'RESTAURANT', version: 1, name: 'Restaurante', businessType: 'RESTAURANT',
    description: 'Menú por categorías con disponibilidad, pedidos para delivery o recojo y reservas de mesa con horario y capacidad.',
    includes: ['Menú: los platos no llevan stock; se marcan como disponibles o no', 'Pedidos con aviso al equipo', 'Reservas de mesa por número de personas, con capacidad por horario', 'Recordatorio de la reserva por WhatsApp', 'Categorías sugeridas del menú'],
    modules: [...BASE, 'orders', 'reservations'],
    settings: {
      catalog: { label: 'Menú', trackStockDefault: false, volumePricing: false, durations: false },
      customers: { businessFields: false },
      reservations: { kind: 'TABLE', slotMinutes: 30, durationMinutes: 90, maxPartySize: 20, minNoticeMinutes: 60, maxDaysAhead: 30, requireConfirmation: true },
    },
    automations: { NEW_ORDER_NOTIFICATION: true, LOW_STOCK_ALERT: false, ERROR_ALERT: true, RESERVATION_REMINDER: true },
    ai: {
      qualifyingQuestions: ['¿Es para delivery, para recoger o para comer en el local?'],
      extraInstructions: 'Ofrece solo platos que aparezcan disponibles en el menú. Para reservar una mesa pide fecha, hora y número de personas, consulta la disponibilidad y confirma los datos con el cliente antes de registrarla.',
    },
    categories: ['Entradas', 'Platos de fondo', 'Bebidas', 'Postres'],
  },
  DISTRIBUTOR: {
    key: 'DISTRIBUTOR', version: 1, name: 'Distribuidora', businessType: 'DISTRIBUTOR',
    description: 'Catálogo mayorista con precios por volumen, clientes comerciales con RUC, pedidos grandes con mínimo, inventario e historial de compras.',
    includes: ['Precios por volumen en cada producto', 'Clientes comerciales (razón social y RUC)', 'Pedido mínimo configurable', 'Inventario con alerta de stock bajo', 'Recordatorio de pedidos sin confirmar'],
    modules: [...BASE, 'inventory', 'orders'],
    settings: { catalog: { label: 'Catálogo mayorista', trackStockDefault: true, volumePricing: true, durations: false }, customers: { businessFields: true } },
    automations: { NEW_ORDER_NOTIFICATION: true, LOW_STOCK_ALERT: true, ERROR_ALERT: true, PENDING_ORDER_REMINDER: true, RESERVATION_REMINDER: false },
    ai: {
      qualifyingQuestions: ['¿Qué cantidades necesitas aproximadamente?'],
      extraInstructions: 'Cuando el catálogo indique precios por volumen, explícalos al cliente con las cantidades exactas. Si hay pedido mínimo y el pedido no llega, díselo antes de registrarlo.',
    },
    categories: [],
  },
  SERVICES: {
    key: 'SERVICES', version: 1, name: 'Negocio de servicios', businessType: 'SERVICES',
    description: 'Catálogo de servicios con duración, citas con horario y disponibilidad, seguimiento de cada cita y recordatorios.',
    includes: ['Servicios con duración (sin stock)', 'Citas con horario de atención y citas simultáneas', 'Estados de la cita: pendiente, confirmada, atendida, no asistió', 'Recordatorio de la cita por WhatsApp'],
    modules: [...BASE, 'reservations'],
    settings: {
      catalog: { label: 'Servicios', trackStockDefault: false, volumePricing: false, durations: true },
      customers: { businessFields: false },
      reservations: { kind: 'APPOINTMENT', slotMinutes: 30, durationMinutes: 60, maxPartySize: 1, minNoticeMinutes: 120, maxDaysAhead: 60, requireConfirmation: true },
    },
    automations: { NEW_ORDER_NOTIFICATION: false, LOW_STOCK_ALERT: false, ERROR_ALERT: true, HANDOFF_NOTIFICATION: true, RESERVATION_REMINDER: true },
    ai: {
      qualifyingQuestions: ['¿Qué servicio te interesa?', '¿Qué día y horario te acomoda?'],
      extraInstructions: 'Para agendar una cita consulta la disponibilidad del servicio y confirma servicio, fecha y hora con el cliente antes de registrarla.',
    },
    categories: [],
  },
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATES) as TemplateKey[];
export const TEMPLATE_SECTIONS = ['modules', 'settings', 'automations', 'ai', 'categories'] as const;
export type TemplateSection = (typeof TEMPLATE_SECTIONS)[number];
