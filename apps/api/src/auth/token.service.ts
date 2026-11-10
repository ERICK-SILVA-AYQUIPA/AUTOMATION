import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, errors } from 'jose';
import { ENV, type Env } from '../config/env.js';
import type { Role } from '../generated/prisma/enums.js';

const ISSUER = 'aisa-api';
const AUDIENCE = 'aisa-web';

export interface AccessClaims {
  sub: string;
  tid: string | null;
  role: Role;
  sid: string;
  email: string;
}

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;
  constructor(@Inject(ENV) private readonly env: Env) {
    this.key = new TextEncoder().encode(env.JWT_SECRET);
  }

  get accessTtl() {
    return this.env.JWT_ACCESS_TTL_SECONDS;
  }

  signAccess(c: AccessClaims): Promise<string> {
    return new SignJWT({ tid: c.tid, role: c.role, sid: c.sid, email: c.email, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(c.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.env.JWT_ACCESS_TTL_SECONDS}s`)
      .sign(this.key);
  }

  /** Devuelve las claims o null si el token es inválido/expirado. */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string') return null;
      return {
        sub: payload.sub,
        tid: (payload.tid as string | null) ?? null,
        role: payload.role as Role,
        sid: payload.sid as string,
        email: payload.email as string,
      };
    } catch (e) {
      if (e instanceof errors.JOSEError) return null;
      throw e;
    }
  }
}
