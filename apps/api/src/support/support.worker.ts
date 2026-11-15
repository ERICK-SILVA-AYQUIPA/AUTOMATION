import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { RenewalsService } from './renewals.service.js';

/** Avisos de vencimiento: cada hora (solo en el proceso worker); idempotente */
@Injectable()
export class SupportWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Renovaciones');
  private timer?: NodeJS.Timeout;

  constructor(private readonly renewals: RenewalsService) {}

  onApplicationBootstrap() {
    const run = () => void this.renewals.sendNotices().then((n) => n && this.log.log(`${n} aviso(s) de vencimiento enviados`)).catch((e) => this.log.warn(`Avisos: ${(e as Error).message}`));
    setTimeout(run, 30_000);
    this.timer = setInterval(run, 3_600_000);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
