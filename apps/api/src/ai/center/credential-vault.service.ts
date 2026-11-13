import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { decrypt, encrypt } from '../../common/crypto/crypto.js';
import { ENV, type Env } from '../../config/env.js';
import { DatabaseService, type Tx } from '../../database/database.service.js';
import { AiProviders } from '../providers/registry.js';
import { hintOf, STATUS_LABEL, validateFields, type CheckOutcome, type Credentials } from '../providers/types.js';

/** Dueño de la credencial: null = la plataforma (administrada, asignable); uuid = esa empresa (clave propia) */
export type Owner = string | null;

const SAFE = {
  id: true, tenantId: true, provider: true, label: true, config: true, secretHint: true, status: true, lastError: true,
  lastCheckedAt: true, connectedAt: true, rotatedAt: true, disabledAt: true, monthlyTokenLimit: true, createdAt: true, updatedAt: true,
} as const;

/**
 * Bóveda de credenciales del Centro de APIs (ADR 046).
 *  - Secretos cifrados con DATA_ENCRYPTION_KEY; la API solo devuelve los últimos caracteres.
 *  - Antes de guardar o rotar, una petición real al proveedor (sin generar texto).
 *  - Las de la plataforma viven con el rol de sistema; las propias, bajo la RLS de su empresa.
 */
@Injectable()
export class CredentialVault {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly providers: AiProviders,
    private readonly audit: AuditService,
  ) {}

  /** Transacción con el rol que corresponde al dueño */
  run<T>(owner: Owner, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return owner ? this.db.tenant(owner, fn) : this.db.system.$transaction(fn);
  }

  /** Descifra los secretos. Las claves migradas de Gemini se guardaron como texto, no JSON */
  open(row: { secretsEnc: string; config: unknown }): Credentials {
    const plain = decrypt(row.secretsEnc, this.env.DATA_ENCRYPTION_KEY);
    let secrets: Record<string, string>;
    try {
      const parsed = JSON.parse(plain) as unknown;
      secrets = parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : { apiKey: plain };
    } catch {
      secrets = { apiKey: plain };
    }
    return { secrets, config: (row.config ?? {}) as Record<string, string> };
  }

  private adapter(provider: string) {
    const a = this.providers.get(provider);
    if (!a) throw new BadRequestException({ code: 'UNKNOWN_PROVIDER', message: `Proveedor sin adaptador: ${provider}` });
    return a;
  }

  list(owner: Owner) {
    return this.run(owner, (tx) => tx.providerCredential.findMany({ where: { tenantId: owner }, orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }], select: SAFE }));
  }

  async get(owner: Owner, id: string) {
    const row = await this.run(owner, (tx) => tx.providerCredential.findFirst({ where: { id, tenantId: owner } }));
    if (!row) throw new NotFoundException({ code: 'CREDENTIAL_NOT_FOUND', message: 'Credencial no encontrada' });
    return row;
  }

  /** Comprueba campos y clave con el proveedor. Solo se acepta una respuesta real positiva */
  private async validate(provider: string, values: Record<string, unknown>) {
    const a = this.adapter(provider);
    const v = validateFields(a.fields, values);
    if (typeof v === 'string') throw new BadRequestException({ code: 'INVALID_FIELDS', message: v });
    const check = await a.check(v);
    if (check.status !== 'CONNECTED' && check.status !== 'CONNECTED_WITH_WARNINGS') {
      throw new BadRequestException({ code: 'CREDENTIAL_REJECTED', status: check.status, message: `${a.name} no aceptó la credencial (${STATUS_LABEL[check.status]}): ${check.detail}` });
    }
    return { creds: v, check };
  }

  async create(owner: Owner, userId: string, input: { provider: string; label?: string; fields: Record<string, unknown>; monthlyTokenLimit?: number | null }) {
    const a = this.adapter(input.provider);
    const { creds, check } = await this.validate(input.provider, input.fields);
    const now = new Date();
    const row = await this.run(owner, async (tx) => {
      const r = await tx.providerCredential.create({
        data: {
          tenantId: owner, provider: a.key, label: input.label?.trim() || a.name, config: creds.config,
          secretsEnc: encrypt(JSON.stringify(creds.secrets), this.env.DATA_ENCRYPTION_KEY), secretHint: hintOf(creds.secrets),
          status: check.status, lastError: check.status === 'CONNECTED' ? null : check.detail.slice(0, 500), lastCheckedAt: now, connectedAt: now,
          monthlyTokenLimit: owner ? null : (input.monthlyTokenLimit ?? null), createdById: userId,
        },
        select: SAFE,
      });
      await tx.integrationCheck.create({ data: { tenantId: owner, service: `ai:${a.key}`, ok: true, latencyMs: Math.round(check.ms), detail: `Credencial nueva: ${check.detail}`.slice(0, 500), checkedById: userId } });
      await this.audit.inTx(tx, { tenantId: owner, userId, action: 'api_center.credential_created', entityType: 'provider_credential', entityId: r.id, metadata: { provider: a.key, hint: r.secretHint, managed: !owner } });
      return r;
    });
    return { ...row, check };
  }

  /** Sustituye el secreto por otro ya validado; las asignaciones siguen apuntando a la misma credencial */
  async rotate(owner: Owner, userId: string, id: string, fields: Record<string, unknown>) {
    const cur = await this.get(owner, id);
    const { creds, check } = await this.validate(cur.provider, fields);
    const now = new Date();
    return this.run(owner, async (tx) => {
      const r = await tx.providerCredential.update({
        where: { id },
        data: { config: creds.config, secretsEnc: encrypt(JSON.stringify(creds.secrets), this.env.DATA_ENCRYPTION_KEY), secretHint: hintOf(creds.secrets), status: check.status, lastError: null, lastCheckedAt: now, rotatedAt: now, disabledAt: null },
        select: SAFE,
      });
      await tx.integrationCheck.create({ data: { tenantId: owner, service: `ai:${cur.provider}`, ok: true, latencyMs: Math.round(check.ms), detail: `Credencial rotada: ${check.detail}`.slice(0, 500), checkedById: userId } });
      await this.audit.inTx(tx, { tenantId: owner, userId, action: 'api_center.credential_rotated', entityType: 'provider_credential', entityId: id, metadata: { provider: cur.provider, from: cur.secretHint, to: r.secretHint } });
      return { ...r, check };
    });
  }

  /** «Probar»: petición real con la clave guardada; el resultado queda como estado y en el historial */
  async test(owner: Owner, userId: string | null, id: string): Promise<CheckOutcome & { id: string }> {
    const cur = await this.get(owner, id);
    if (cur.disabledAt) return { id, status: 'DISABLED', detail: 'La credencial está desconectada', ms: 0 };
    const check = await this.adapter(cur.provider).check(this.open(cur));
    const ok = check.status === 'CONNECTED' || check.status === 'CONNECTED_WITH_WARNINGS';
    const now = new Date();
    await this.run(owner, async (tx) => {
      await tx.providerCredential.update({ where: { id }, data: { status: check.status, lastError: check.status === 'CONNECTED' ? null : check.detail.slice(0, 500), lastCheckedAt: now, ...(ok && !cur.connectedAt ? { connectedAt: now } : {}) } });
      await tx.integrationCheck.create({ data: { tenantId: owner, service: `ai:${cur.provider}`, ok, latencyMs: Math.round(check.ms), detail: check.detail.slice(0, 500), checkedById: userId } });
    });
    return { id, ...check };
  }

  /**
   * Desconectar: deja de usarse en el acto. Las asignaciones que la usan se
   * desactivan (la empresa no cambia de proveedor sola) y sale de los respaldos.
   */
  async disable(owner: Owner, userId: string, id: string) {
    const cur = await this.get(owner, id);
    return this.run(owner, async (tx) => {
      const affected = await tx.aiAssignment.findMany({ where: { credentialId: id, isActive: true }, select: { id: true, tenantId: true } });
      await tx.aiAssignment.updateMany({ where: { credentialId: id }, data: { isActive: false } });
      await tx.aiAssignment.updateMany({ where: { fallbackCredentialId: id }, data: { fallbackCredentialId: null, fallbackModel: null } });
      await tx.providerCredential.update({ where: { id }, data: { status: 'DISABLED', disabledAt: new Date() } });
      for (const t of new Set(affected.map((x) => x.tenantId))) {
        await tx.notification.create({ data: { tenantId: t, type: 'ai_notice', title: 'Asistente de IA sin proveedor', body: `Se desconectó la credencial de ${cur.label}: el asistente pasa las conversaciones a tu equipo hasta que se asigne otra.`, data: { key: `credential_disabled:${id}` } } });
      }
      await this.audit.inTx(tx, { tenantId: owner, userId, action: 'api_center.credential_disabled', entityType: 'provider_credential', entityId: id, metadata: { provider: cur.provider, hint: cur.secretHint, assignmentsDeactivated: affected.length } });
      return { id, status: 'DISABLED' as const, assignmentsDeactivated: affected.length };
    });
  }

  /** Eliminar: solo si ninguna asignación la usa (antes hay que quitar o cambiar esas asignaciones) */
  async remove(owner: Owner, userId: string, id: string) {
    const cur = await this.get(owner, id);
    await this.run(owner, async (tx) => {
      const used = await tx.aiAssignment.count({ where: { credentialId: id } });
      if (used) throw new ConflictException({ code: 'CREDENTIAL_IN_USE', message: `La usan ${used} asignación(es): quítalas o cámbialas antes de eliminarla.` });
      await tx.providerCredential.delete({ where: { id } });
      await this.audit.inTx(tx, { tenantId: owner, userId, action: 'api_center.credential_removed', entityType: 'provider_credential', entityId: id, metadata: { provider: cur.provider, hint: cur.secretHint } });
    });
  }
}
