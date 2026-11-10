import { Injectable } from '@nestjs/common';
import { DatabaseService, type Tx } from '../database/database.service.js';
import type { Prisma } from '../generated/prisma/client.js';

export interface AuditEntry {
  tenantId: string | null;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
}

/** Auditoría de operaciones. Tabla de solo-anexar (RLS impide UPDATE/DELETE). */
@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  /** Dentro de una transacción de empresa (mismo tenant fijado por RLS). */
  inTx(tx: Tx, e: AuditEntry) {
    return tx.auditLog.create({ data: { ...e, metadata: e.metadata ?? {} } });
  }

  /** Acciones de sistema / plataforma (sin transacción de empresa). */
  system(e: AuditEntry) {
    return this.db.system.auditLog.create({ data: { ...e, metadata: e.metadata ?? {} } });
  }
}
