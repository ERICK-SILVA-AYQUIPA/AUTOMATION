import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { Public } from '../common/decorators/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';
import { REDIS } from './redis.provider.js';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  private readonly log = new Logger('Health');
  constructor(
    private readonly db: DatabaseService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** El proceso está vivo (para reinicios del orquestador). */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Listo para recibir tráfico: dependencias críticas accesibles. */
  @Get('ready')
  async ready() {
    const check = async (fn: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await fn();
        return { status: 'up', ms: Date.now() - t };
      } catch (e) {
        // El detalle (hosts, usuarios) solo va al log: esta ruta es pública
        this.log.warn(`Comprobación de salud fallida: ${(e as Error).message}`);
        return { status: 'down' };
      }
    };
    const checks = {
      database: await check(() => this.db.ping()),
      redis: await check(() => this.redis.ping()),
    };
    const ok = Object.values(checks).every((c) => c.status === 'up');
    if (!ok) throw new ServiceUnavailableException({ status: 'error', checks });
    return { status: 'ok', checks };
  }
}
