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
  express.set('trust proxy', env.isProd ? 1 : false); // detrás de un único reverse proxy en producción
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
