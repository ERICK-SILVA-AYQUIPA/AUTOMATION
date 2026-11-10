import { Inject, Injectable, Module, Global, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env.js';

export const REDIS = Symbol('REDIS');

@Injectable()
class RedisCloser implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly r: Redis) {}
  async onModuleDestroy() {
    await this.r.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env) =>
        new Redis({ host: env.REDIS_HOST, port: env.REDIS_HOST_PORT, password: env.REDIS_PASSWORD, db: 1, lazyConnect: false, maxRetriesPerRequest: 2 }),
    },
    RedisCloser,
  ],
  exports: [REDIS],
})
export class RedisModule {}
