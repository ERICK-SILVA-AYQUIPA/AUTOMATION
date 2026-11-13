import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { APP_VERSION } from '../deliveries/version.js';
import { compareVersions } from './version-compare.js';

const version = z.string().trim().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'Versión no válida');

export const recordUpdateSchema = z
  .object({
    fromVersion: version,
    toVersion: version,
    status: z.enum(['SUCCEEDED', 'FAILED', 'ROLLED_BACK']),
    startedAt: z.coerce.date(),
    backupPath: z.string().trim().max(500).nullish(),
    detail: z.string().trim().max(4000).nullish(),
  })
  .strict();
export type RecordUpdateInput = z.infer<typeof recordUpdateSchema>;

interface MigrationRow { migration_name: string; started_at: Date; finished_at: Date | null; rolled_back_at: Date | null }

/**
 * Versión instalada, migraciones y historial de actualizaciones (ADR 045).
 * El historial lo escribe el actualizador (instalaciones independientes) o
 * deploy.sh (plataforma) mediante el CLI, con el resultado real de la salud.
 */
@Injectable()
export class SystemService {
  constructor(private readonly db: DatabaseService) {}

  private migrations() {
    return this.db.system.$queryRaw<MigrationRow[]>`
      SELECT migration_name, started_at, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at, migration_name`;
  }

  async status() {
    const rows = await this.migrations();
    const applied = rows.filter((r) => r.finished_at && !r.rolled_back_at);
    const failed = rows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => ({ name: r.migration_name, startedAt: r.started_at }));
    const last = applied.at(-1);
    const updates = await this.db.system.systemUpdate.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    const deliveries = await this.db.system.delivery.findMany({
      where: { status: 'DELIVERED' },
      distinct: ['tenantId'],
      orderBy: [{ tenantId: 'asc' }, { number: 'desc' }],
      select: { tenantId: true, number: true, appVersion: true, deliveredAt: true, tenant: { select: { name: true } } },
    });
    const behind = deliveries
      .filter((d) => { try { return compareVersions(d.appVersion, APP_VERSION) < 0; } catch { return true; } })
      .map((d) => ({ tenantId: d.tenantId, tenant: d.tenant.name, number: d.number, version: d.appVersion, deliveredAt: d.deliveredAt }));
    return {
      version: APP_VERSION,
      migrations: { applied: applied.length, last: last ? { name: last.migration_name, at: last.finished_at } : null, failed },
      updates,
      installationsBehind: behind,
    };
  }

  /** Migraciones terminadas desde `since` (las que aplicó esta actualización) */
  async migrationsSince(since: Date) {
    return (await this.migrations()).filter((r) => r.finished_at && !r.rolled_back_at && r.started_at >= since).map((r) => r.migration_name);
  }

  async record(raw: RecordUpdateInput) {
    const input = recordUpdateSchema.parse(raw);
    const finishedAt = new Date();
    const migrations = input.status === 'SUCCEEDED' ? await this.migrationsSince(input.startedAt) : [];
    return this.db.system.systemUpdate.create({
      data: {
        fromVersion: input.fromVersion, toVersion: input.toVersion, status: input.status, migrations,
        backupPath: input.backupPath ?? null, detail: input.detail ?? null,
        startedAt: input.startedAt > finishedAt ? finishedAt : input.startedAt, finishedAt,
      },
    });
  }
}
