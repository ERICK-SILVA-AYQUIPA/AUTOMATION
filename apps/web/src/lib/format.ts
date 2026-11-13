export const money = (v: string | number | null | undefined, currency = 'PEN') =>
  new Intl.NumberFormat('es-PE', { style: 'currency', currency }).format(Number(v ?? 0));

export const num = (v: number | string | null | undefined) => new Intl.NumberFormat('es-PE').format(Number(v ?? 0));

export const dateTime = (v: string | Date | null | undefined) =>
  v ? new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) : '—';

export const date = (v: string | Date | null | undefined) => (v ? new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium' }).format(new Date(v)) : '—');

export const ORDER_STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  PENDING: { label: 'Pendiente', tone: 'warning' },
  CONFIRMED: { label: 'Confirmado', tone: 'info' },
  PREPARING: { label: 'En preparación', tone: 'info' },
  SHIPPED: { label: 'Enviado', tone: 'info' },
  DELIVERED: { label: 'Entregado', tone: 'success' },
  CANCELLED: { label: 'Anulado', tone: 'danger' },
};

export const MOVEMENT_TYPE: Record<string, string> = {
  PURCHASE_IN: 'Entrada por compra',
  SALE_OUT: 'Salida por venta',
  ADJUSTMENT: 'Ajuste de stock',
  RETURN_IN: 'Devolución',
  TRANSFER_IN: 'Transferencia (entrada)',
  TRANSFER_OUT: 'Transferencia (salida)',
  SALE_VOID: 'Anulación de venta',
};

export const ROLE_LABEL: Record<string, string> = {
  PLATFORM_ADMIN: 'Administrador general',
  TENANT_ADMIN: 'Administrador',
  SUPERVISOR: 'Supervisor',
  SELLER: 'Vendedor',
};

export const PRODUCT_STATUS = { ACTIVE: 'Activo', INACTIVE: 'Inactivo', ARCHIVED: 'Archivado' } as const;

/** Teléfono para mostrar. WhatsApp puede omitir el número y enviar solo el identificador de usuario. */
export const phoneLabel = (phone: string | null | undefined) => (phone ? `+${phone}` : 'Sin número (contacto de WhatsApp)');

/** Nombre del cliente: el guardado por la empresa, o el de su perfil de WhatsApp, o el teléfono */
export const customerLabel = (c: { name: string | null; phone: string | null; waProfileName?: string | null }) => c.name ?? c.waProfileName ?? phoneLabel(c.phone);

export const PAYMENT_METHOD: Record<string, string> = { YAPE: 'Yape', PLIN: 'Plin', BANK_TRANSFER: 'Transferencia', CASH: 'Efectivo', OTHER: 'Otro' };

export const BUSINESS_TYPE: Record<string, string> = {
  RETAIL: 'Tienda / comercio', RESTAURANT: 'Restaurante', DISTRIBUTOR: 'Distribuidora', SERVICES: 'Servicios', PHARMACY: 'Farmacia', OTHER: 'Otro',
};

export const DEPLOYMENT_MODE: Record<string, string> = { SAAS: 'SaaS compartido', DEDICATED: 'Instancia dedicada', CUSTOM: 'Solución a medida' };

/** Mismo orden y claves que MODULES en la API (common/decorators/module.decorator.ts) */
export const MODULE_LABEL: Record<string, string> = {
  conversations: 'Conversaciones', ai: 'Asistente IA', catalog: 'Productos y categorías', inventory: 'Inventario',
  orders: 'Pedidos', customers: 'Clientes', reports: 'Reportes', automations: 'Automatizaciones',
};
