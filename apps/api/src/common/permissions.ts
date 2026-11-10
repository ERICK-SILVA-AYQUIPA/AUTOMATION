import { Role } from '../generated/prisma/enums.js';

const ALL_TENANT: Role[] = [Role.TENANT_ADMIN, Role.SUPERVISOR, Role.SELLER];

/**
 * Matriz de permisos (RBAC). Es la ÚNICA fuente de verdad de autorización;
 * el frontend solo la consulta para ocultar opciones, nunca para proteger datos.
 */
export const PERMISSIONS = {
  'platform:manage': [Role.PLATFORM_ADMIN],
  'tenant:read': ALL_TENANT,
  'tenant:settings': [Role.TENANT_ADMIN],
  'users:read': [Role.TENANT_ADMIN, Role.SUPERVISOR],
  'users:manage': [Role.TENANT_ADMIN],
  'products:read': ALL_TENANT,
  'products:write': [Role.TENANT_ADMIN],
  'inventory:read': ALL_TENANT,
  'inventory:write': [Role.TENANT_ADMIN],
  'customers:read': ALL_TENANT,
  'customers:write': [Role.TENANT_ADMIN, Role.SELLER, Role.SUPERVISOR],
  'orders:read': ALL_TENANT,
  'orders:write': [Role.TENANT_ADMIN, Role.SELLER, Role.SUPERVISOR],
  'conversations:read': ALL_TENANT,
  'conversations:reply': ALL_TENANT,
  'conversations:assign': [Role.TENANT_ADMIN, Role.SUPERVISOR],
  'reports:read': [Role.TENANT_ADMIN, Role.SUPERVISOR],
  'integrations:manage': [Role.TENANT_ADMIN],
  'ai:configure': [Role.TENANT_ADMIN],
  'automations:manage': [Role.TENANT_ADMIN],
  'audit:read': [Role.TENANT_ADMIN],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const hasPermission = (role: Role, p: Permission) => (PERMISSIONS[p] as readonly Role[]).includes(role);

export const permissionsFor = (role: Role): Permission[] =>
  (Object.keys(PERMISSIONS) as Permission[]).filter((p) => hasPermission(role, p));
