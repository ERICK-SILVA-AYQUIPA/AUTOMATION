import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
import { MailService } from '../mail/mail.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthTokenType } from '../generated/prisma/enums.js';
import { assertWithinLimit, getPlanLimits } from '../plans/plan-limits.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import type { InviteUserInput, UpdateUserInput } from './users.schemas.js';
import { ChatwootService } from '../chatwoot/chatwoot.service.js';
import { Inject } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

const PUBLIC_FIELDS = {
  id: true, email: true, name: true, role: true, status: true, emailVerifiedAt: true, lastLoginAt: true, createdAt: true,
} as const;

/**
 * Gestión de usuarios de una empresa. Todas las consultas pasan por
 * db.tenant(): RLS limita a la empresa del usuario autenticado.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
    private readonly chatwoot: ChatwootService,
  ) {}

  list(p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, (tx) =>
      tx.user.findMany({ where: { tenantId: p.tenantId }, select: PUBLIC_FIELDS, orderBy: { createdAt: 'asc' } }),
    );
  }

  async get(p: TenantPrincipal, id: string) {
    const u = await this.db.tenant(p.tenantId, (tx) =>
      tx.user.findFirst({ where: { id, tenantId: p.tenantId }, select: PUBLIC_FIELDS }),
    );
    if (!u) throw new NotFoundException('Usuario no encontrado');
    return u;
  }

  async invite(p: TenantPrincipal, input: InviteUserInput) {
    // El correo es único en toda la plataforma: se comprueba con el rol de sistema
    // (RLS ocultaría usuarios de otras empresas) sin revelar a qué empresa pertenece.
    const taken = await this.db.system.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (taken) throw new ConflictException('Ese correo ya está registrado en la plataforma');

    const user = await this.db.tenant(p.tenantId, async (tx) => {
      const limits = await getPlanLimits(tx);
      const active = await tx.user.count({ where: { tenantId: p.tenantId, status: { not: 'DISABLED' } } });
      assertWithinLimit(active, limits.maxUsers, 'usuarios');
      const created = await tx.user.create({
        data: { tenantId: p.tenantId, email: input.email, name: input.name, role: input.role, status: 'INVITED' },
        select: PUBLIC_FIELDS,
      });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'user.invited', entityType: 'user', entityId: created.id, metadata: { role: input.role } });
      return created;
    });
    await this.sendInvitation(user.id, user.email, user.name);
    return user;
  }

  async resendInvitation(p: TenantPrincipal, id: string) {
    const u = await this.get(p, id);
    if (u.status !== 'INVITED') throw new BadRequestException('El usuario ya aceptó la invitación');
    await this.sendInvitation(u.id, u.email, u.name);
  }

  /** También la usa el alta de empresas desde la plataforma (ADR 039) */
  async sendInvitation(userId: string, email: string, name: string) {
    const raw = await this.auth.issueToken(userId, AuthTokenType.INVITATION);
    const link = `${this.env.APP_PUBLIC_URL}/aceptar-invitacion?token=${encodeURIComponent(raw)}`;
    await this.mail.send({
      to: email,
      subject: 'Te invitaron a AI Sales Assistant',
      text: `Hola ${name},\n\nTe invitaron a unirte al equipo. Crea tu contraseña aquí (válido 7 días):\n${link}`,
    });
  }

  async update(p: TenantPrincipal, id: string, input: UpdateUserInput) {
    if (id === p.userId && (input.role || input.status)) {
      throw new BadRequestException('No puedes cambiar tu propio rol ni tu estado');
    }
    let revokeChatwoot = false;
    const updated = await this.db.tenant(p.tenantId, async (tx) => {
      const current = await tx.user.findFirst({ where: { id, tenantId: p.tenantId } });
      if (!current) throw new NotFoundException('Usuario no encontrado');
      if (input.status === 'ACTIVE' && current.status === 'INVITED') {
        throw new BadRequestException('El usuario debe aceptar la invitación');
      }
      if (input.status === 'ACTIVE' && current.status === 'DISABLED') {
        const limits = await getPlanLimits(tx);
        const active = await tx.user.count({ where: { tenantId: p.tenantId, status: { not: 'DISABLED' } } });
        assertWithinLimit(active, limits.maxUsers, 'usuarios');
      }
      const updated = await tx.user.update({ where: { id }, data: input, select: PUBLIC_FIELDS });
      if (input.status === 'DISABLED' || (input.role && input.role !== current.role)) {
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        revokeChatwoot = true;
      }
      await this.audit.inTx(tx, {
        tenantId: p.tenantId, userId: p.userId, action: 'user.updated', entityType: 'user', entityId: id,
        metadata: { changes: input, previous: { role: current.role, status: current.status } },
      });
      return updated;
    });
    // Como con las sesiones del panel: desactivar o cambiar el rol corta también el acceso a Chatwoot
    if (revokeChatwoot) await this.chatwoot.revokeUser(p.tenantId, id);
    return updated;
  }
}
