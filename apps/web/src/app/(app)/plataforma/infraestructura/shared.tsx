'use client';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export const STATUS: Record<string, { label: string; tone: Tone }> = {
  CONNECTED: { label: 'Conectado', tone: 'success' },
  CONNECTED_WITH_WARNINGS: { label: 'Conectado con avisos', tone: 'warning' },
  AUTH_ERROR: { label: 'Token rechazado', tone: 'danger' },
  PERMISSION_DENIED: { label: 'Sin permisos', tone: 'danger' },
  UNAVAILABLE: { label: 'No disponible', tone: 'warning' },
  INCOMPLETE: { label: 'Sin probar', tone: 'neutral' },
  PENDING_AUTHORIZATION: { label: 'Pendiente', tone: 'neutral' },
  DISABLED: { label: 'Desactivado', tone: 'neutral' },
};
export const REQUEST_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING_APPROVAL: { label: 'Por aprobar', tone: 'warning' },
  REJECTED: { label: 'Rechazada', tone: 'danger' },
  CANCELLED: { label: 'Cancelada', tone: 'neutral' },
  CREATING: { label: 'Creando', tone: 'info' },
  CREATED: { label: 'Creado', tone: 'success' },
  FAILED: { label: 'Falló', tone: 'danger' },
};
export const SERVER_STATUS: Record<string, { label: string; tone: Tone }> = {
  initializing: { label: 'Iniciando', tone: 'info' }, starting: { label: 'Encendiendo', tone: 'info' }, running: { label: 'Encendido', tone: 'success' },
  stopping: { label: 'Apagando', tone: 'warning' }, off: { label: 'Apagado', tone: 'neutral' }, deleting: { label: 'Eliminando', tone: 'warning' },
  migrating: { label: 'Migrando', tone: 'info' }, rebuilding: { label: 'Reinstalando', tone: 'info' }, unknown: { label: 'Desconocido', tone: 'warning' },
  missing: { label: 'No existe en el proveedor', tone: 'danger' }, deleted: { label: 'Eliminado', tone: 'neutral' },
};
export const OPERATION: Record<string, string> = {
  VERIFY: 'Prueba de conexión', ROTATE: 'Token cambiado', IMPORT: 'Servidor registrado', REQUEST: 'Solicitud', REQUEST_REJECTED: 'Solicitud rechazada', REQUEST_CANCELLED: 'Solicitud cancelada',
  FIREWALL_CREATED: 'Firewall creado', SERVER_CREATED: 'Servidor creado', SERVER_CREATE_FAILED: 'Falló la creación', SYNC: 'Sincronización', POWER_POWERON: 'Encendido',
  POWER_SHUTDOWN: 'Apagado ordenado', POWER_POWEROFF: 'Apagado forzado', POWER_REBOOT: 'Reinicio', SERVER_DELETED: 'Servidor eliminado', SERVER_DELETE_FAILED: 'Falló la eliminación',
};

export const eur = (v: string | number | null | undefined, currency: string | null) =>
  new Intl.NumberFormat('es-PE', { style: 'currency', currency: currency ?? 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(v ?? 0));

export interface Provider {
  id: string; kind: string; label: string; secretHint: string; status: string; lastError: string | null; lastCheckedAt: string | null; disabledAt: string | null; currency: string | null;
  monthlyBudget: string | null; maxServers: number | null; allowedLocations: string[]; allowedServerTypes: string[]; defaultImage: string; sshSourceCidrs: string[];
  costs: { monthToDate: string; committedMonthly: string; activeServers: number; unknownPrice: number; basis: string };
}
export interface Catalog {
  currency: string; vatRate: string | null;
  locations: { name: string; description: string; country: string; city: string; allowed: boolean }[];
  serverTypes: { name: string; description: string; cores: number; memoryGb: number; diskGb: number; prices: { location: string; hourly: { net: string }; monthly: { net: string } }[]; availableIn: string[]; deprecated: boolean; allowed: boolean }[];
}
export interface Operation { id: string; kind: string; ok: boolean; detail: Record<string, unknown>; createdAt: string }
