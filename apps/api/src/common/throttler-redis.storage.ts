import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

/** Cuenta atómica por ventana fija: INCR + PEXPIRE la primera vez. Devuelve [aciertos, ms restantes] */
const SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {hits, ttl}`;

/**
 * Límite de peticiones guardado en Redis en lugar de en memoria: se comparte entre
 * varias instancias de la API y sobrevive a reinicios (un reinicio no regala otra
 * tanda de intentos de login). Si Redis falla, deja pasar la petición y lo registra:
 * el bloqueo por cuenta tras intentos fallidos sigue protegiendo el login.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly log = new Logger('Throttler');
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async increment(key: string, ttl: number, limit: number, _blockDuration: number, throttlerName: string) {
    try {
      const [hits, left] = (await this.redis.eval(SCRIPT, 1, `${this.prefix}:throttle:${throttlerName}:${key}`, String(ttl))) as [number, number];
      const blocked = hits > limit;
      const secs = Math.ceil(left / 1000);
      return { totalHits: hits, timeToExpire: secs, isBlocked: blocked, timeToBlockExpire: blocked ? secs : 0 };
    } catch (e) {
      this.log.error(`Redis no disponible para el límite de peticiones: ${(e as Error).message}`);
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
