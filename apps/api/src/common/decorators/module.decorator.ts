import { SetMetadata } from '@nestjs/common';

/**
 * Módulos que la plataforma activa por empresa (tenants.enabled_modules).
 * Las plantillas por sector y el plan deciden cuáles se encienden; AuthGuard
 * rechaza con 403 MODULE_DISABLED las rutas de un módulo apagado.
 */
export const MODULES = ['conversations', 'ai', 'catalog', 'inventory', 'orders', 'customers', 'reports', 'automations', 'reservations'] as const;
export type ModuleKey = (typeof MODULES)[number];

export const REQUIRED_MODULE = 'aisa:module';
export const RequireModule = (m: ModuleKey) => SetMetadata(REQUIRED_MODULE, m);
