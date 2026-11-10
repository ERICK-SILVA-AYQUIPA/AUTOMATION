import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DatabaseService } from '../../database/database.service.js';
import { TokenService } from '../../auth/token.service.js';
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from '../decorators/auth.decorators.js';
import { hasPermission, type Permission } from '../permissions.js';
import type { Principal } from '../context/principal.js';

/**
 * Guard global: toda ruta exige un access token válido salvo @Public().
 * Además del JWT, comprueba en BD que la sesión siga viva y que usuario y
 * empresa estén activos (revocación inmediata al desactivar/cerrar sesión).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Falta el token de acceso');

    const claims = await this.tokens.verifyAccess(token);
    if (!claims) throw new UnauthorizedException('Token inválido o expirado');

    const session = await this.db.system.session.findUnique({
      where: { id: claims.sid },
      select: {
        revokedAt: true,
        expiresAt: true,
        userId: true,
        user: { select: { status: true, tenantId: true, role: true, tenant: { select: { status: true } } } },
      },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== claims.sub) {
      throw new UnauthorizedException('Sesión no válida');
    }
    if (session.user.status !== 'ACTIVE') throw new UnauthorizedException('Usuario inactivo');
    if (session.user.tenant && session.user.tenant.status !== 'ACTIVE') {
      throw new ForbiddenException('La empresa está suspendida');
    }

    // Rol y tenant se toman de la BD (no del token) por si cambiaron tras emitirlo.
    const principal: Principal = {
      userId: claims.sub,
      tenantId: session.user.tenantId,
      role: session.user.role,
      sessionId: claims.sid,
      email: claims.email,
    };
    req.principal = principal;

    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    for (const p of required) {
      if (!hasPermission(principal.role, p)) throw new ForbiddenException('No tienes permiso para esta acción');
    }
    return true;
  }
}
