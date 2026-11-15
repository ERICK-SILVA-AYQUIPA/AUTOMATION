import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { QUEUE, Queues, queueConnection, type ProvisioningJob } from '../queues/queues.module.js';
import { ProvisioningEngine } from './engine.js';
import { FLOW } from './steps.js';

/**
 * Consumidor de la cola de instalaciones (solo en el proceso worker). Un
 * barrido cada 20 s encola las ejecuciones a las que les toca avanzar: así se
 * recuperan si el worker se reinició o Redis perdió un trabajo.
 */
@Injectable()
export class ProvisioningWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Instalaciones');
  private worker?: Worker<ProvisioningJob>;
  private sweeper?: NodeJS.Timeout;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly queues: Queues,
    private readonly engine: ProvisioningEngine,
  ) {}

  onApplicationBootstrap() {
    this.worker = new Worker<ProvisioningJob>(QUEUE.PROVISIONING, (job) => this.engine.advance(job.data.runId), { connection: queueConnection(this.env), prefix: this.env.QUEUE_PREFIX, concurrency: 3 });
    this.worker.on('error', (e) => this.log.error(`Cola: ${e.message}`));
    this.sweeper = setInterval(() => void this.sweep().catch((e) => this.log.warn(`Barrido: ${(e as Error).message}`)), 20_000);
    this.log.log('Cola provisioning lista');
  }

  async sweep() {
    const now = new Date();
    const due = await this.db.system.provisioningRun.findMany({
      where: { status: { in: FLOW }, nextRunAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      select: { id: true, nextRunAt: true },
      take: 100,
    });
    if (!due.length) return 0;
    await this.queues.provisioning.addBulk(due.map((r) => ({ name: 'advance', data: { runId: r.id }, opts: { jobId: `prov-${r.id}-${r.nextRunAt!.getTime()}` } })));
    return due.length;
  }

  async onApplicationShutdown() {
    if (this.sweeper) clearInterval(this.sweeper);
    await this.worker?.close();
  }
}
