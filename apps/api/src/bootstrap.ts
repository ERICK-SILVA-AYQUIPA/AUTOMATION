import { INestApplication, StandardSchemaValidationPipe, BadRequestException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { ENV, type Env } from './config/env.js';

/** Configuración común de la app (usada por main.ts y por las pruebas e2e). */
export function configureApp(app: INestApplication) {
  const env = app.get<Env>(ENV);
  const express = app as NestExpressApplication;
  // IP real del cliente para el límite de peticiones y la auditoría. En desarrollo la
  // web (Next, en 127.0.0.1) reenvía /api con X-Forwarded-For; sin esto todos los
  // usuarios compartirían la IP del proxy y el mismo cupo de intentos de login.
  const tp = env.TRUST_PROXY;
  express.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'false' ? false : tp.split(',').map((x) => x.trim()));
  express.disable('x-powered-by');
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-Id'],
  });
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      exceptionFactory: (issues) =>
        new BadRequestException({
          message: 'Datos inválidos',
          code: 'VALIDATION_ERROR',
          errors: issues.map((i) => ({
            path: (i.path ?? []).map((s) => (typeof s === 'object' ? String(s.key) : String(s))).join('.'),
            message: i.message,
          })),
        }),
    }),
  );
  app.enableShutdownHooks();
  return env;
}
