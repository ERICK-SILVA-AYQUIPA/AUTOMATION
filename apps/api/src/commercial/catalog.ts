import { MODULES } from '../common/decorators/module.decorator.js';
import { FEATURES } from '../plans/plan-limits.js';

/**
 * Lo que el producto hace HOY, descrito para la página comercial y el agente.
 * Cada texto corresponde a una función construida y probada (ver
 * docs/architecture/ACEPTACION.md). Si un módulo cambia, se cambia aquí.
 * Los textos de venta (titular, problemas, beneficios, preguntas, testimonios)
 * no van aquí: los escribe la plataforma en el panel.
 */
export const MODULE_INFO: Record<(typeof MODULES)[number], { name: string; description: string }> = {
  conversations: { name: 'Conversaciones de WhatsApp', description: 'Bandeja con los chats de WhatsApp Business (API oficial de Meta): asignación, etiquetas, notas internas y paso a una persona.' },
  ai: { name: 'Asistente de IA', description: 'Responde por WhatsApp con el catálogo, los precios y el stock reales, registra pedidos pendientes y pasa a una persona cuando hace falta. Se configura, se prueba y se publica desde el panel.' },
  catalog: { name: 'Productos y categorías', description: 'Catálogo con variantes, precios por volumen, imágenes e importación.' },
  inventory: { name: 'Inventario', description: 'Stock por sucursal con historial de movimientos, alertas de stock bajo y transferencias.' },
  orders: { name: 'Pedidos', description: 'Pedidos con estados; al confirmarlos se descuenta el stock y al anularlos se devuelve.' },
  customers: { name: 'Clientes', description: 'Ficha de cada cliente con su historial de compras y conversaciones.' },
  reports: { name: 'Reportes', description: 'Ventas, productos más vendidos e inventario, con exportación a CSV.' },
  automations: { name: 'Automatizaciones', description: 'Avisos al equipo y al cliente (pedidos nuevos, estados, stock bajo, recordatorios) que se activan y configuran sin programar.' },
  reservations: { name: 'Reservas y citas', description: 'Mesas o citas por servicio con horario, aforo y recordatorio por WhatsApp.' },
};

export const FEATURE_INFO: Record<string, string> = {
  [FEATURES.HUMAN_HANDOFF]: 'Paso de conversaciones a una persona',
  [FEATURES.REPORTS]: 'Reportes',
  [FEATURES.ADVANCED_AUTOMATIONS]: 'Automatizaciones avanzadas',
  [FEATURES.ADVANCED_AI]: 'IA avanzada',
  [FEATURES.MULTI_BRANCH]: 'Varias sucursales',
  [FEATURES.ADVANCED_ROLES]: 'Roles avanzados',
};

export const DEPLOYMENT_INFO = {
  SAAS: { name: 'En nuestra plataforma', description: 'Tu empresa funciona dentro de nuestra plataforma, con sus datos aislados de las demás. Es la forma más rápida de empezar.' },
  DEDICATED: { name: 'Instancia dedicada', description: 'Un sistema propio para tu empresa, con su dominio y su base de datos, instalado con nuestro paquete de entrega.' },
  CUSTOM: { name: 'Solución a medida', description: 'El mismo núcleo con módulos y automatizaciones adaptados a tu operación.' },
} as const;
