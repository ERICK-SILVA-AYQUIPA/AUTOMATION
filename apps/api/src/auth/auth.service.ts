import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { MailService } from '../mail/mail.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TokenService } from './token.service.js';
import { randomToken, sha256 } from '../common/crypto/crypto.js';
import { AuthTokenType, Role, PlanCode } from '../generated/prisma/enums.js';
import { permissionsFor } from '../common/permissions.js';
import { subscriptionAccess } from '../plans/subscription-access.js';
import { bootstrapTenant, slugify, uniqueSlug } from '../tenants/tenant-bootstrap.js';
import type { RegisterCompanyInput, LoginInput, ResetPasswordInput, AcceptInvitationInput } from './auth.schemas.js';

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const TOKEN_TTL_MIN: Record<AuthTokenType, number> = {
  EMAIL_VERIFICATION: 60 * 24,
  PASSWORD_RESET: 30,
  INVITATION: 60 * 24 * 7,
};

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

// Se mantiene la exportación para los módulos que ya la importan desde aquí
export { slugify } from '../tenants/tenant-bootstrap.js';

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);
  /** Hash ficticio para igualar tiempos cuando el correo no existe. */
  private dummyHash: Promise<string>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {
    this.dummyHash = argon2.hash(randomToken(), ARGON_OPTS);
  }

  hashPassword(p: string) {
    return argon2.hash(p, ARGON_OPTS);
  }

  // ------------------------------------------------------------------ registro

  /**
   * Registra una empresa nueva con su administrador. Se usa el rol de sistema
   * porque la empresa todavía no existe (no hay tenant que fijar).
   */
  async registerCompany(input: RegisterCompanyInput, client: ClientInfo) {
    const email = input.email.toLowerCase();
    const exists = await this.db.system.user.findUnique({ where: { email }, select: { id: true } });
    if (exists) throw new ConflictException('Ya existe una cuenta con ese correo');

    const plan = await this.db.system.plan.findUnique({ where: { code: PlanCode.BASIC } });
    if (!plan) throw new Error('Planes no inicializados: ejecuta el seed de la base de datos');

    const passwordHash = await this.hashPassword(input.password);
    const verifyToken = randomToken();
    const now = new Date();
    const trialEnd = new Date(now.getTime() + this.env.TRIAL_DAYS * 86_400_000);

    const result = await this.db.system.$transaction(async (tx) => {
      const slug = await uniqueSlug(tx, slugify(input.companyName));
      const tenant = await tx.tenant.create({
        data: { name: input.companyName.trim(), slug, currency: input.currency, timezone: input.timezone, activatedAt: now },
      });
      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          planId: plan.id,
          status: 'TRIALING',
          trialEndsAt: trialEnd,
          currentPeriodStart: now,
          currentPeriodEnd: trialEnd,
        },
      });
      await bootstrapTenant(tx, tenant.id);
      const user = await tx.user.create({
        data: { tenantId: tenant.id, email, name: input.adminName.trim(), passwordHash, role: Role.TENANT_ADMIN },
      });
      await tx.authToken.create({
        data: {
          userId: user.id,
          type: AuthTokenType.EMAIL_VERIFICATION,
          tokenHash: sha256(verifyToken),
          expiresAt: new Date(now.getTime() + TOKEN_TTL_MIN.EMAIL_VERIFICATION * 60_000),
        },
      });
      await tx.auditLog.create({
        data: { tenantId: tenant.id, userId: user.id, action: 'tenant.registered', entityType: 'tenant', entityId: tenant.id, ip: client.ip, userAgent: client.userAgent },
      });
      return { tenant, user };
    });

    await this.sendVerificationEmail(email, input.adminName, verifyToken);
    return { tenantId: result.tenant.id, tenantSlug: result.tenant.slug, userId: result.user.id };
  }

  // ------------------------------------------------------------------ login / sesiones

  async login(input: LoginInput, client: ClientInfo): Promise<IssuedSession> {
    const email = input.email.toLowerCase();
    const user = await this.db.system.user.findUnique({
      where: { email },
      include: { tenant: { select: { status: true } } },
    });
    const invalid = new UnauthorizedException('Correo o contraseña incorrectos');

    if (!user?.passwordHash) {
      await argon2.verify(await this.dummyHash, input.password).catch(() => false);
      throw invalid;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException('Cuenta bloqueada temporalmente por intentos fallidos. Inténtalo más tarde.');
    }
    const ok = await argon2.verify(user.passwordHash, input.password);
    if (!ok) {
      // Incremento atómico: intentos en paralelo no pueden saltarse el bloqueo
      const { failedLoginCount: failed } = await this.db.system.user.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      if (failed >= MAX_FAILED_LOGINS) {
        await this.db.system.user.update({
          where: { id: user.id },
          data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) },
        });
      }
      await this.audit.system({ tenantId: user.tenantId, userId: user.id, action: 'auth.login_failed', ip: client.ip, userAgent: client.userAgent });
      throw invalid;
    }
    if (user.status !== 'ACTIVE') throw new ForbiddenException('El usuario está desactivado');
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException({ message: 'Debes verificar tu correo antes de iniciar sesión', code: 'EMAIL_NOT_VERIFIED' });
    }
    if (user.tenant && user.tenant.status === 'SUSPENDED') throw new ForbiddenException('La empresa está suspendida');

    if (argon2.needsRehash(user.passwordHash, ARGON_OPTS)) {
      await this.db.system.user.update({ where: { id: user.id }, data: { passwordHash: await this.hashPassword(input.password) } });
    }
    await this.db.system.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const issued = await this.createSession(user, randomUUID(), client);
    await this.audit.system({ tenantId: user.tenantId, userId: user.id, action: 'auth.login', ip: client.ip, userAgent: client.userAgent });
    return issued;
  }

  private async createSession(
    user: { id: string; tenantId: string | null; role: Role; email: string },
    familyId: string,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const refreshToken = randomToken();
    const refreshExpiresAt = new Date(Date.now() + this.env.REFRESH_TTL_DAYS * 86_400_000);
    const session = await this.db.system.session.create({
      data: {
        userId: user.id,
        tenantId: user.tenantId,
        refreshTokenHash: sha256(refreshToken),
        familyId,
        userAgent: client.userAgent?.slice(0, 255),
        ip: client.ip,
        expiresAt: refreshExpiresAt,
      },
    });
    const accessToken = await this.tokens.signAccess({
      sub: user.id,
      tid: user.tenantId,
      role: user.role,
      sid: session.id,
      email: user.email,
    });
    return { accessToken, expiresIn: this.tokens.accessTtl, refreshToken, refreshExpiresAt };
  }

  /**
   * Rotación de refresh token. Si llega un token ya rotado (posible robo),
   * se revoca toda la familia de sesiones de ese inicio de sesión.
   */
  async refresh(refreshToken: string, client: ClientInfo): Promise<IssuedSession> {
    const session = await this.db.system.session.findUnique({
      where: { refreshTokenHash: sha256(refreshToken) },
      include: { user: { include: { tenant: { select: { status: true } } } } },
    });
    const invalid = new UnauthorizedException('Sesión expirada. Inicia sesión de nuevo.');
    if (!session) throw invalid;

    if (session.rotatedAt) {
      await this.db.system.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.system({ tenantId: session.tenantId, userId: session.userId, action: 'auth.refresh_reuse_detected', ip: client.ip, userAgent: client.userAgent });
      this.log.warn(`Reutilización de refresh token detectada (familia ${session.familyId}); sesiones revocadas`);
      throw invalid;
    }
    if (session.revokedAt || session.expiresAt < new Date()) throw invalid;
    const { user } = session;
    if (user.status !== 'ACTIVE' || (user.tenant && user.tenant.status === 'SUSPENDED')) throw invalid;

    // Marcado atómico: solo una petición concurrente puede rotar este token.
    const claimed = await this.db.system.session.updateMany({
      where: { id: session.id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: new Date(), revokedAt: new Date() },
    });
    if (claimed.count !== 1) throw invalid;
    return this.createSession(user, session.familyId, client);
  }

  async logout(refreshToken: string | undefined, sessionId?: string) {
    if (refreshToken) {
      await this.db.system.session.updateMany({
        where: { refreshTokenHash: sha256(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    if (sessionId) {
      await this.db.system.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
  }

  listSessions(userId: string, currentSessionId: string) {
    return this.db.system.session
      .findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, userAgent: true, ip: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: 'desc' },
      })
      .then((rows) => rows.map((r) => ({ ...r, current: r.id === currentSessionId })));
  }

  async revokeSession(userId: string, sessionId: string) {
    const r = await this.db.system.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return r.count === 1;
  }

  async me(userId: string) {
    const u = await this.db.system.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true, email: true, name: true, role: true, tenantId: true, emailVerifiedAt: true,
        tenant: { select: { id: true, name: true, slug: true, status: true, currency: true, timezone: true, enabledModules: true, logoUrl: true, brandColor: true, deploymentMode: true, subscription: { select: { status: true, trialEndsAt: true, currentPeriodEnd: true, plan: { select: { code: true, name: true } } } } } },
      },
    });
    const sub = u.tenant?.subscription;
    const access = sub ? subscriptionAccess(sub, this.env.BILLING_GRACE_DAYS) : null;
    return { ...u, tenant: u.tenant && { ...u.tenant, subscription: sub && { ...sub, access } }, billingContact: u.tenantId ? this.env.BILLING_CONTACT : '', permissions: permissionsFor(u.role) };
  }

  // ------------------------------------------------------------------ tokens de un solo uso

  private async consumeToken(raw: string, type: AuthTokenType) {
    const token = await this.db.system.authToken.findUnique({ where: { tokenHash: sha256(raw) } });
    if (!token || token.type !== type || token.usedAt || token.expiresAt < new Date()) {
      throw new BadRequestException('El enlace no es válido o ha expirado');
    }
    const claimed = await this.db.system.authToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) throw new BadRequestException('El enlace ya fue utilizado');
    return token;
  }

  async issueToken(userId: string, type: AuthTokenType): Promise<string> {
    const raw = randomToken();
    // Invalida tokens previos del mismo tipo
    await this.db.system.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
    await this.db.system.authToken.create({
      data: { userId, type, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + TOKEN_TTL_MIN[type] * 60_000) },
    });
    return raw;
  }

  async verifyEmail(raw: string) {
    const t = await this.consumeToken(raw, AuthTokenType.EMAIL_VERIFICATION);
    const u = await this.db.system.user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } });
    await this.audit.system({ tenantId: u.tenantId, userId: u.id, action: 'auth.email_verified' });
  }

  /** Respuesta idéntica exista o no el correo (no revela cuentas). */
  async resendVerification(emailRaw: string) {
    const user = await this.db.system.user.findUnique({ where: { email: emailRaw.toLowerCase() } });
    if (!user || user.emailVerifiedAt || user.status !== 'ACTIVE') return;
    const raw = await this.issueToken(user.id, AuthTokenType.EMAIL_VERIFICATION);
    await this.sendVerificationEmail(user.email, user.name, raw);
  }

  async forgotPassword(emailRaw: string, client: ClientInfo) {
    const user = await this.db.system.user.findUnique({ where: { email: emailRaw.toLowerCase() } });
    if (!user || user.status !== 'ACTIVE') return;
    const raw = await this.issueToken(user.id, AuthTokenType.PASSWORD_RESET);
    const link = `${this.env.APP_PUBLIC_URL}/restablecer-contrasena?token=${encodeURIComponent(raw)}`;
    await this.mail.send({
      to: user.email,
      subject: 'Restablecer tu contraseña',
      text: `Hola ${user.name},\n\nPara crear una nueva contraseña abre este enlace (válido 30 minutos):\n${link}\n\nSi no lo solicitaste, ignora este mensaje.`,
    });
    await this.audit.system({ tenantId: user.tenantId, userId: user.id, action: 'auth.password_reset_requested', ip: client.ip, userAgent: client.userAgent });
  }

  async resetPassword(input: ResetPasswordInput, client: ClientInfo) {
    const t = await this.consumeToken(input.token, AuthTokenType.PASSWORD_RESET);
    const passwordHash = await this.hashPassword(input.password);
    const u = await this.db.system.user.update({
      where: { id: t.userId },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    });
    // Cierra todas las sesiones abiertas
    await this.db.system.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.system({ tenantId: u.tenantId, userId: u.id, action: 'auth.password_reset', ip: client.ip, userAgent: client.userAgent });
  }

  async acceptInvitation(input: AcceptInvitationInput, client: ClientInfo) {
    const t = await this.consumeToken(input.token, AuthTokenType.INVITATION);
    const passwordHash = await this.hashPassword(input.password);
    const u = await this.db.system.user.update({
      where: { id: t.userId },
      data: {
        passwordHash,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(), // el enlace llegó a su correo
        ...(input.name ? { name: input.name } : {}),
      },
    });
    await this.audit.system({ tenantId: u.tenantId, userId: u.id, action: 'user.invitation_accepted', ip: client.ip, userAgent: client.userAgent });
  }

  private sendVerificationEmail(email: string, name: string, raw: string) {
    const link = `${this.env.APP_PUBLIC_URL}/verificar-correo?token=${encodeURIComponent(raw)}`;
    return this.mail.send({
      to: email,
      subject: 'Confirma tu correo - AI Sales Assistant',
      text: `Hola ${name},\n\nConfirma tu correo para activar tu cuenta:\n${link}\n\nEl enlace vence en 24 horas.`,
    });
  }
}
