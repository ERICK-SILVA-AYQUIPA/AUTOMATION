import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { WebhookSender, type ClaimedDelivery } from './webhook-sender.js';

const BATCH = 20;

/** Entrega los webhooks salientes con reintentos (worker). Varios workers no toman la misma entrega. */
@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WebhookDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly sender: WebhookSender,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 5_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = await this.db.system.$queryRaw<ClaimedDelivery[]>`
        UPDATE webhook_deliveries d SET attempts = d.attempts + 1, next_attempt_at = now() + interval '2 minutes'
        FROM webhook_endpoints e
        WHERE e.id = d.endpoint_id AND d.id IN (
          SELECT id FROM webhook_deliveries WHERE status = 'PENDING' AND next_attempt_at <= now()
          ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING d.id, d.tenant_id, d.endpoint_id, d.event, d.payload, d.attempts, e.url, e.secret_enc`;
      await Promise.all(rows.map((r) => this.sender.deliver(r)));
      return rows.length;
    } catch (e) {
      this.log.error(`Fallo al procesar webhooks: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
