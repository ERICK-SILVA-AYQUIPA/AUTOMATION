import { createParamDecorator, ExecutionContext, SetMetadata, ForbiddenException } from '@nestjs/common';
import type { Permission } from '../permissions.js';
import type { Principal, TenantPrincipal } from '../context/principal.js';

export const IS_PUBLIC = 'aisa:isPublic';
export const REQUIRED_PERMISSIONS = 'aisa:permissions';

/** Ruta accesible sin autenticación. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_READ_ONLY = 'aisa:allowReadOnly';
/** Ruta que modifica datos pero sigue permitida con la suscripción vencida (sesión, contraseña). */
export const AllowWhenReadOnly = () => SetMetadata(ALLOW_READ_ONLY, true);

/** Requiere TODOS los permisos indicados. */
export const RequirePermission = (...p: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, p);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest().principal;
});

/** Igual que CurrentUser pero exige que el usuario pertenezca a una empresa. */
export const TenantUser = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantPrincipal => {
  const p: Principal | undefined = ctx.switchToHttp().getRequest().principal;
  if (!p?.tenantId) throw new ForbiddenException('Esta operación requiere una cuenta de empresa');
  return p as TenantPrincipal;
});
