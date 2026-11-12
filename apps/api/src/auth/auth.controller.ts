import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, Res, ForbiddenException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';
import { AuthService, type ClientInfo, type IssuedSession } from './auth.service.js';
import {
  acceptInvitationSchema, emailOnlySchema, loginSchema, registerCompanySchema, resetPasswordSchema, tokenSchema,
  type AcceptInvitationInput, type LoginInput, type RegisterCompanyInput, type ResetPasswordInput,
} from './auth.schemas.js';
import { AllowWhenReadOnly, CurrentUser, Public } from '../common/decorators/auth.decorators.js';
import type { Principal } from '../common/context/principal.js';
import { randomToken, safeEqual } from '../common/crypto/crypto.js';

export const REFRESH_COOKIE = 'aisa_rt';
export const CSRF_COOKIE = 'aisa_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const AUTH_PATH = '/api/v1/auth';

const clientInfo = (req: Request): ClientInfo => ({ ip: req.ip, userAgent: req.get('user-agent') ?? undefined });

/** Límite estricto en endpoints sensibles a fuerza bruta: 10 peticiones/min por IP. */
const STRICT = { default: { limit: 10, ttl: 60_000 } };

@AllowWhenReadOnly()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private setSessionCookies(res: Response, s: IssuedSession) {
    const secure = this.env.isProd;
    res.cookie(REFRESH_COOKIE, s.refreshToken, {
      httpOnly: true, secure, sameSite: 'lax', path: AUTH_PATH, expires: s.refreshExpiresAt,
    });
    // Double-submit CSRF: legible por el frontend, se reenvía en la cabecera X-CSRF-Token
    res.cookie(CSRF_COOKIE, randomToken(16), {
      httpOnly: false, secure, sameSite: 'lax', path: '/', expires: s.refreshExpiresAt,
    });
  }

  private clearSessionCookies(res: Response) {
    res.clearCookie(REFRESH_COOKIE, { path: AUTH_PATH });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  /** Endpoints que se autentican con la cookie de refresh requieren CSRF. */
  private assertCsrf(req: Request) {
    const cookie = req.cookies?.[CSRF_COOKIE];
    const header = req.get(CSRF_HEADER);
    if (!cookie || !header || !safeEqual(cookie, header)) throw new ForbiddenException('Token CSRF inválido');
  }

  @Public()
  @Throttle(STRICT)
  @Post('register')
  async register(@Body({ schema: registerCompanySchema }) body: RegisterCompanyInput, @Req() req: Request) {
    const r = await this.auth.registerCompany(body, clientInfo(req));
    return { ...r, message: 'Empresa registrada. Revisa tu correo para verificar la cuenta.' };
  }

  @Public()
  @Throttle(STRICT)
  @HttpCode(200)
  @Post('login')
  async login(@Body({ schema: loginSchema }) body: LoginInput, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.login(body, clientInfo(req));
    this.setSessionCookies(res, s);
    return { accessToken: s.accessToken, expiresIn: s.expiresIn };
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.assertCsrf(req);
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) {
      this.clearSessionCookies(res);
      throw new ForbiddenException('No hay sesión');
    }
    try {
      const s = await this.auth.refresh(token, clientInfo(req));
      this.setSessionCookies(res, s);
      return { accessToken: s.accessToken, expiresIn: s.expiresIn };
    } catch (e) {
      this.clearSessionCookies(res);
      throw e;
    }
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.assertCsrf(req);
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    this.clearSessionCookies(res);
  }

  @Get('me')
  me(@CurrentUser() p: Principal) {
    return this.auth.me(p.userId);
  }

  @Get('sessions')
  sessions(@CurrentUser() p: Principal) {
    return this.auth.listSessions(p.userId, p.sessionId);
  }

  @HttpCode(204)
  @Delete('sessions/:id')
  async revoke(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string) {
    if (!(await this.auth.revokeSession(p.userId, id))) throw new NotFoundException('Sesión no encontrada');
  }

  @Public()
  @Throttle(STRICT)
  @HttpCode(204)
  @Post('verify-email')
  async verifyEmail(@Body({ schema: tokenSchema }) body: { token: string }) {
    await this.auth.verifyEmail(body.token);
  }

  @Public()
  @Throttle(STRICT)
  @HttpCode(202)
  @Post('resend-verification')
  async resend(@Body({ schema: emailOnlySchema }) body: { email: string }) {
    await this.auth.resendVerification(body.email);
    return { message: 'Si la cuenta existe y no está verificada, enviamos un nuevo correo.' };
  }

  @Public()
  @Throttle(STRICT)
  @HttpCode(202)
  @Post('forgot-password')
  async forgot(@Body({ schema: emailOnlySchema }) body: { email: string }, @Req() req: Request) {
    await this.auth.forgotPassword(body.email, clientInfo(req));
    return { message: 'Si el correo está registrado, recibirás un enlace para restablecer la contraseña.' };
  }

  @Public()
  @Throttle(STRICT)
  @HttpCode(204)
  @Post('reset-password')
  async reset(@Body({ schema: resetPasswordSchema }) body: ResetPasswordInput, @Req() req: Request) {
    await this.auth.resetPassword(body, clientInfo(req));
  }

  @Public()
  @Throttle(STRICT)
  @HttpCode(204)
  @Post('accept-invitation')
  async accept(@Body({ schema: acceptInvitationSchema }) body: AcceptInvitationInput, @Req() req: Request) {
    await this.auth.acceptInvitation(body, clientInfo(req));
  }
}
