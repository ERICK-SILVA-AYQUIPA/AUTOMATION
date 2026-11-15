import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { FinanceService } from './finance.service.js';

/** Alertas de consumo contra los presupuestos: cada hora (solo en el proceso worker); idempotente */
@Injectable()
export class FinanceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Presupuestos');
  private timer?: NodeJS.Timeout;

  constructor(private readonly finance: FinanceService) {}

  onApplicationBootstrap() {
    const run = () => void this.finance.checkBudgets().then((n) => n && this.log.log(`${n} alerta(s) de consumo enviadas`)).catch((e) => this.log.warn(`Alertas: ${(e as Error).message}`));
    setTimeout(run, 45_000);
    this.timer = setInterval(run, 3_600_000);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
