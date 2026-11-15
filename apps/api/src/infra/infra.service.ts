import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { decrypt, encrypt } from '../common/crypto/crypto.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { installNo } from '../quotes/quote-pdf.js';
import { HetznerAdapter, sshFingerprint } from './providers/hetzner.adapter.js';
import { InfraError, hintOf, type FirewallRule, type InfraAdapter, type InfraCredentials, type InfraKind, type PowerAction, type RemoteServer } from './providers/types.js';

const KINDS = ['HETZNER'] as const;
const name = z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'Nombre: letras minúsculas, números y guiones (máx. 63)');
const code = z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/);

/** CIDR sin bits de host (Hetzner rechaza 10.0.1.42/24): IPv4 o IPv6 */
export function cidrError(c: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(c);
  if (m) {
    const parts = m.slice(1, 5).map(Number);
    const bits = Number(m[5]);
    if (parts.some((p) => p > 255) || bits > 32) return `${c}: dirección inválida`;
    const ip = parts.reduce((a, p) => a * 256 + p, 0);
    const hostBits = 2 ** (32 - bits);
    return ip % hostBits === 0 ? null : `${c}: tiene bits de host; usa la red (p. ej. ${c.replace(/\.\d+\//, '.0/')})`;
  }
  if (/^[0-9a-f:]+\/\d{1,3}$/i.test(c) && Number(c.split('/')[1]) <= 128) return null;
  return `${c}: escribe la red en formato CIDR (203.0.113.10/32)`;
}

const limitsShape = {
  label: z.string().trim().min(1).max(80),
  monthlyBudget: z.union([z.string(), z.number(), z.null()]).transform((v) => (v === null || v === '' ? null : String(v).trim())).refine((v) => v === null || (/^\d{1,8}(\.\d{1,2})?$/.test(v) && Number(v) > 0), 'Presupuesto inválido'),
  maxServers: z.number().int().min(0).max(1000).nullable(),
  allowedLocations: z.array(code).max(50).default([]),
  allowedServerTypes: z.array(code).max(100).default([]),
  defaultImage: z.string().trim().min(2).max(80).default('ubuntu-24.04'),
  sshSourceCidrs: z.array(z.string().trim()).max(20).default([]).superRefine((v, ctx) => v.forEach((c, i) => { const e = cidrError(c); if (e) ctx.addIssue({ code: 'custom', path: [i], message: e }); })),
};
export const limitsSchema = z.object(limitsShape);
export const providerSchema = z.object({ kind: z.enum(KINDS), token: z.string().trim().min(10).max(200), ...limitsShape });
export const tokenSchema = z.object({ token: z.string().trim().min(10).max(200) });
export const sshKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  publicKey: z.string().trim().max(5000).regex(/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( .*)?$/, 'Pega la clave PÚBLICA (empieza con ssh-ed25519, ssh-rsa o ecdsa-…). Nunca la privada.'),
});
export const requestSchema = z.object({
  providerId: z.uuid(),
  installationOrderId: z.uuid().nullable().optional(),
  purpose: z.string().trim().min(5, 'Explica para qué es el servidor').max(500),
  name,
  serverType: code,
  location: code,
  image: z.string().trim().min(2).max(80).optional(),
});
export const approveSchema = z.object({
  confirmName: z.string().trim(),
  acceptCost: z.literal(true, 'Confirma que autorizas el gasto mensual estimado'),
  note: z.string().trim().max(1000).nullable().optional(),
});
export const decisionSchema = z.object({ note: z.string().trim().min(3).max(1000) });
export const deleteSchema = z.object({ confirmName: z.string().trim(), reason: z.string().trim().min(5, 'Escribe el motivo').max(1000) });
export const powerSchema = z.object({ action: z.enum(['poweron', 'shutdown', 'poweroff', 'reboot']) });

const SAFE = {
  id: true, kind: true, label: true, secretHint: true, status: true, lastError: true, lastCheckedAt: true, connectedAt: true, rotatedAt: true, disabledAt: true,
  currency: true, monthlyBudget: true, maxServers: true, allowedLocations: true, allowedServerTypes: true, defaultImage: true, sshSourceCidrs: true, createdAt: true, updatedAt: true,
} as const;

/** Estados de servidor que siguen costando (todo lo que no está eliminado) */
const msPerHour = 3_600_000;

/**
 * Gestor de infraestructura (ADR 050). Token del proveedor cifrado (nunca se
 * devuelve), límites y presupuesto por proveedor, y un flujo de dos pasos para
 * todo lo que cuesta dinero: solicitud → aprobación explícita (nombre escrito,
 * gasto aceptado, presupuesto y límites verificados en ese momento). Borrar un
 * servidor exige escribir su nombre y un motivo. Cada llamada al proveedor queda
 * en un registro que solo se agrega. Ningún agente de IA tiene acceso a esto.
 */
@Injectable()
export class InfraService {
  private readonly adapters: Map<InfraKind, InfraAdapter>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {
    this.adapters = new Map<InfraKind, InfraAdapter>([['HETZNER', new HetznerAdapter(env.HETZNER_API_BASE_URL)]]);
  }

  /**
   * El orquestador (ADR 051) registra aquí cómo obtener el cloud-init de una
   * solicitud que pertenece a una instalación; las demás se crean sin user_data.
   */
  private userDataProvider?: (requestId: string) => Promise<string | undefined>;
  setUserDataProvider(fn: (requestId: string) => Promise<string | undefined>) {
    this.userDataProvider = fn;
  }

  private adapter(kind: InfraKind) {
    const a = this.adapters.get(kind);
    if (!a) throw new BadRequestException('Proveedor sin adaptador');
    return a;
  }

  kinds() {
    return [...this.adapters.values()].map((a) => ({ kind: a.kind, label: a.label, capabilities: a.capabilities }));
  }

  private creds(p: { secretsEnc: string }): InfraCredentials {
    return JSON.parse(decrypt(p.secretsEnc, this.env.DATA_ENCRYPTION_KEY)) as InfraCredentials;
  }

  private async provider(id: string) {
    const p = await this.db.system.infraProvider.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Proveedor no encontrado');
    return p;
  }

  /** Error del proveedor → respuesta clara (sin exponer el token) */
  private fail(e: unknown): never {
    if (e instanceof InfraError) {
      const status = e.httpStatus;
      const msg = `${e.message} (${e.code})`;
      if (status === 401) throw new BadRequestException({ code: 'PROVIDER_AUTH', message: `El proveedor rechazó el token: ${msg}` });
      if (status === 403) throw new BadRequestException({ code: 'PROVIDER_FORBIDDEN', message: `El token no tiene permiso para esta operación (¿es de solo lectura?): ${msg}` });
      if (status === 429) throw new ConflictException({ code: 'PROVIDER_RATE_LIMIT', message: 'El proveedor limitó las solicitudes: intenta en un minuto' });
      throw new ConflictException({ code: 'PROVIDER_ERROR', message: `El proveedor respondió: ${msg}` });
    }
    throw e;
  }

  private log(providerId: string, kind: string, ok: boolean, detail: Record<string, unknown>, userId: string | null, ids: { serverId?: string; requestId?: string } = {}) {
    return this.db.system.infraOperation.create({ data: { providerId, kind, ok, detail: detail as Prisma.InputJsonObject, userId, serverId: ids.serverId ?? null, requestId: ids.requestId ?? null } });
  }

  // ---------------------------------------------------------------- Proveedores

  async providers() {
    const rows = await this.db.system.infraProvider.findMany({ orderBy: { createdAt: 'asc' }, select: SAFE });
    const out = [];
    for (const p of rows) out.push({ ...p, monthlyBudget: p.monthlyBudget?.toFixed(2) ?? null, costs: await this.costs(p.id) });
    return out;
  }

  async getProvider(id: string) {
    const p = await this.db.system.infraProvider.findUnique({ where: { id }, select: SAFE });
    if (!p) throw new NotFoundException('Proveedor no encontrado');
    const operations = await this.db.system.infraOperation.findMany({ where: { providerId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { ...p, monthlyBudget: p.monthlyBudget?.toFixed(2) ?? null, costs: await this.costs(id), operations, capabilities: this.adapter(p.kind).capabilities };
  }

  /** Guarda solo si el proveedor acepta el token (prueba real, sin crear nada) */
  async createProvider(userId: string, input: z.infer<typeof providerSchema>) {
    const a = this.adapter(input.kind);
    const bad = a.validateToken(input.token);
    if (bad) throw new BadRequestException({ code: 'TOKEN_FORMAT', message: bad });
    const c = { token: input.token };
    const v = await a.verify(c);
    if (!v.ok) throw new BadRequestException({ code: v.status, message: v.message });
    const cur = await a.currency(c).catch(() => null);
    const { token: _t, kind, ...limits } = input;
    const p = await this.db.system.infraProvider.create({
      data: { kind, ...limits, secretsEnc: encrypt(JSON.stringify(c), this.env.DATA_ENCRYPTION_KEY), secretHint: hintOf(input.token), status: 'CONNECTED', lastCheckedAt: new Date(), connectedAt: new Date(), currency: cur?.currency ?? null, createdById: userId },
      select: { id: true },
    });
    await this.log(p.id, 'VERIFY', true, { message: v.message, ...v.details }, userId);
    await this.audit.system({ tenantId: null, userId, action: 'infra.provider_created', entityType: 'infra_provider', entityId: p.id, metadata: { kind, label: input.label, budget: limits.monthlyBudget } });
    return this.getProvider(p.id);
  }

  async updateLimits(userId: string, id: string, input: z.infer<typeof limitsSchema>) {
    const before = await this.provider(id);
    await this.db.system.infraProvider.update({ where: { id }, data: input });
    await this.audit.system({ tenantId: null, userId, action: 'infra.provider_limits', entityType: 'infra_provider', entityId: id, metadata: { from: before.monthlyBudget?.toFixed(2) ?? null, to: input.monthlyBudget, maxServers: input.maxServers } });
    return this.getProvider(id);
  }

  async rotate(userId: string, id: string, token: string) {
    const p = await this.provider(id);
    const a = this.adapter(p.kind);
    const bad = a.validateToken(token);
    if (bad) throw new BadRequestException({ code: 'TOKEN_FORMAT', message: bad });
    const v = await a.verify({ token });
    if (!v.ok) throw new BadRequestException({ code: v.status, message: v.message });
    await this.db.system.infraProvider.update({ where: { id }, data: { secretsEnc: encrypt(JSON.stringify({ token }), this.env.DATA_ENCRYPTION_KEY), secretHint: hintOf(token), status: 'CONNECTED', lastError: null, lastCheckedAt: new Date(), rotatedAt: new Date() } });
    await this.log(id, 'ROTATE', true, { message: v.message }, userId);
    await this.audit.system({ tenantId: null, userId, action: 'infra.provider_rotated', entityType: 'infra_provider', entityId: id });
    return this.getProvider(id);
  }

  async test(userId: string, id: string) {
    const p = await this.provider(id);
    const v = await this.adapter(p.kind).verify(this.creds(p));
    await this.db.system.infraProvider.update({ where: { id }, data: { status: p.disabledAt ? 'DISABLED' : v.status, lastError: v.ok ? null : v.message, lastCheckedAt: new Date(), ...(v.ok && !p.connectedAt ? { connectedAt: new Date() } : {}) } });
    await this.log(id, 'VERIFY', v.ok, { message: v.message, ...v.details }, userId);
    return { ok: v.ok, status: v.status, message: v.message, details: v.details ?? {} };
  }

  async setDisabled(userId: string, id: string, disabled: boolean) {
    await this.provider(id);
    await this.db.system.infraProvider.update({ where: { id }, data: disabled ? { disabledAt: new Date(), status: 'DISABLED' } : { disabledAt: null, status: 'INCOMPLETE' } });
    await this.audit.system({ tenantId: null, userId, action: disabled ? 'infra.provider_disabled' : 'infra.provider_enabled', entityType: 'infra_provider', entityId: id });
    return disabled ? this.getProvider(id) : (await this.test(userId, id), this.getProvider(id));
  }

  /** Regiones y tamaños con precio y disponibilidad, leídos del proveedor; marca los permitidos */
  async catalog(id: string) {
    const p = await this.provider(id);
    const a = this.adapter(p.kind);
    const c = this.creds(p);
    try {
      const [locations, types, cur] = await Promise.all([a.locations(c), a.serverTypes(c), a.currency(c)]);
      return {
        currency: cur.currency, vatRate: cur.vatRate,
        locations: locations.map((l) => ({ ...l, allowed: !p.allowedLocations.length || p.allowedLocations.includes(l.name) })),
        serverTypes: types.map((t) => ({ ...t, allowed: !p.allowedServerTypes.length || p.allowedServerTypes.includes(t.name) })),
      };
    } catch (e) {
      this.fail(e);
    }
  }

  /** Servidores que existen en la cuenta, registrados aquí o no */
  async remoteServers(id: string) {
    const p = await this.provider(id);
    let remote: RemoteServer[];
    try {
      remote = await this.adapter(p.kind).listServers(this.creds(p));
    } catch (e) {
      this.fail(e);
    }
    const known = await this.db.system.infraServer.findMany({ where: { providerId: id }, select: { id: true, externalId: true, deletedAt: true } });
    const byExt = new Map(known.map((k) => [k.externalId, k]));
    return remote.map((r) => ({ ...r, registeredId: byExt.get(r.externalId)?.id ?? null }));
  }

  /** Registra un servidor que ya existía en la cuenta (para ver su costo y operarlo) */
  async importServer(userId: string, id: string, externalId: string) {
    const p = await this.provider(id);
    const a = this.adapter(p.kind);
    const c = this.creds(p);
    let r: RemoteServer | null;
    let types;
    try {
      [r, types] = await Promise.all([a.getServer(c, externalId), a.serverTypes(c)]);
    } catch (e) {
      this.fail(e);
    }
    if (!r) throw new NotFoundException('El servidor no existe en la cuenta');
    if (await this.db.system.infraServer.findUnique({ where: { providerId_externalId: { providerId: id, externalId } } })) throw new ConflictException({ code: 'ALREADY_REGISTERED', message: 'Ese servidor ya está registrado' });
    const price = types.find((t) => t.name === r.serverType)?.prices.find((x) => x.location === r.location);
    const s = await this.db.system.infraServer.create({
      data: {
        providerId: id, externalId, name: r.name, status: r.status, serverType: r.serverType, location: r.location, image: r.image, ipv4: r.ipv4, ipv6: r.ipv6,
        firewallExternalId: r.firewalls[0] ?? null, priceHourly: price?.hourly.net ?? null, priceMonthly: price?.monthly.net ?? null, currency: p.currency, imported: true,
        providerCreatedAt: new Date(r.createdAt), lastSyncedAt: new Date(),
      },
    });
    await this.log(id, 'IMPORT', true, { externalId, name: r.name }, userId, { serverId: s.id });
    await this.audit.system({ tenantId: null, userId, action: 'infra.server_imported', entityType: 'infra_server', entityId: s.id, metadata: { externalId, name: r.name } });
    return this.server(s.id);
  }

  // ---------------------------------------------------------------- Claves SSH

  sshKeys() {
    return this.db.system.infraSshKey.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async addSshKey(userId: string, input: z.infer<typeof sshKeySchema>) {
    let fingerprint: string;
    try {
      fingerprint = sshFingerprint(input.publicKey);
    } catch {
      throw new BadRequestException('Clave pública SSH inválida');
    }
    if (await this.db.system.infraSshKey.findUnique({ where: { fingerprint } })) throw new ConflictException({ code: 'DUPLICATE_KEY', message: 'Esa clave ya está registrada' });
    const k = await this.db.system.infraSshKey.create({ data: { name: input.name, publicKey: input.publicKey, fingerprint, createdById: userId } });
    await this.audit.system({ tenantId: null, userId, action: 'infra.ssh_key_added', entityType: 'infra_ssh_key', entityId: k.id, metadata: { fingerprint } });
    return k;
  }

  async setSshKeyActive(userId: string, id: string, isActive: boolean) {
    if (!(await this.db.system.infraSshKey.findUnique({ where: { id } }))) throw new NotFoundException('Clave no encontrada');
    const k = await this.db.system.infraSshKey.update({ where: { id }, data: { isActive } });
    await this.audit.system({ tenantId: null, userId, action: isActive ? 'infra.ssh_key_enabled' : 'infra.ssh_key_disabled', entityType: 'infra_ssh_key', entityId: id });
    return k;
  }

  // ---------------------------------------------------------------- Costos

  /** Costo estimado del mes (UTC) con el precio por hora sin impuesto, con tope mensual por servidor */
  async costs(providerId: string) {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const servers = await this.db.system.infraServer.findMany({ where: { providerId, OR: [{ deletedAt: null }, { deletedAt: { gte: monthStart } }] }, select: { priceHourly: true, priceMonthly: true, providerCreatedAt: true, deletedAt: true } });
    let monthToDate = 0;
    let committed = 0;
    let unknownPrice = 0;
    for (const s of servers) {
      if (s.priceHourly == null || s.priceMonthly == null) {
        unknownPrice++;
        continue;
      }
      const from = Math.max(s.providerCreatedAt.getTime(), monthStart.getTime());
      const to = (s.deletedAt ?? now).getTime();
      const hours = Math.max(0, Math.ceil((to - from) / msPerHour));
      monthToDate += Math.min(hours * Number(s.priceHourly), Number(s.priceMonthly));
      if (!s.deletedAt) committed += Number(s.priceMonthly);
    }
    const creating = await this.db.system.infraServerRequest.aggregate({ where: { providerId, status: 'CREATING' }, _sum: { priceMonthly: true } });
    committed += Number(creating._sum.priceMonthly ?? 0);
    const active = servers.filter((s) => !s.deletedAt).length;
    return { monthToDate: monthToDate.toFixed(2), committedMonthly: committed.toFixed(2), activeServers: active, unknownPrice, basis: 'Estimado con el precio por hora sin impuestos; el proveedor no ofrece la factura por API' };
  }

  // ---------------------------------------------------------------- Solicitudes

  requests(status?: string) {
    return this.db.system.infraServerRequest.findMany({
      where: status ? { status: status as never } : {},
      orderBy: { number: 'desc' },
      take: 200,
      include: { provider: { select: { id: true, label: true, kind: true } }, installationOrder: { select: { id: true, number: true, status: true, lead: { select: { id: true, name: true, company: true } } } }, server: { select: { id: true, name: true, status: true } } },
    });
  }

  /** Revisa lo que se puede comprobar al pedir y otra vez al aprobar */
  private async checkRequest(p: Awaited<ReturnType<InfraService['provider']>>, r: { serverType: string; location: string; installationOrderId?: string | null; priceMonthly?: number }, excludeId?: string) {
    if (p.disabledAt) throw new ConflictException({ code: 'PROVIDER_DISABLED', message: 'El proveedor está desactivado' });
    if (p.status !== 'CONNECTED') throw new ConflictException({ code: 'PROVIDER_NOT_CONNECTED', message: 'Prueba la conexión del proveedor antes de pedir servidores' });
    if (p.monthlyBudget == null) throw new ConflictException({ code: 'NO_BUDGET', message: 'Define el presupuesto mensual del proveedor antes de crear servidores' });
    if (p.allowedLocations.length && !p.allowedLocations.includes(r.location)) throw new BadRequestException({ code: 'LOCATION_NOT_ALLOWED', message: `La región ${r.location} no está permitida` });
    if (p.allowedServerTypes.length && !p.allowedServerTypes.includes(r.serverType)) throw new BadRequestException({ code: 'TYPE_NOT_ALLOWED', message: `El tamaño ${r.serverType} no está permitido` });
    if (r.installationOrderId) {
      const io = await this.db.system.installationOrder.findUnique({ where: { id: r.installationOrderId }, select: { status: true, number: true } });
      if (!io) throw new NotFoundException('Orden de instalación no encontrada');
      if (io.status !== 'AUTHORIZED' && io.status !== 'IN_PROGRESS') throw new ConflictException({ code: 'INSTALLATION_CLOSED', message: `La orden ${installNo(io.number)} no está vigente` });
      const live = await this.db.system.infraServerRequest.findFirst({ where: { installationOrderId: r.installationOrderId, status: { in: ['PENDING_APPROVAL', 'CREATING', 'CREATED'] }, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { number: true } });
      if (live) throw new ConflictException({ code: 'INSTALLATION_HAS_SERVER', message: `La orden ${installNo(io.number)} ya tiene la solicitud de servidor #${live.number}` });
    }
    const active = await this.db.system.infraServer.count({ where: { providerId: p.id, deletedAt: null } });
    const creating = await this.db.system.infraServerRequest.count({ where: { providerId: p.id, status: 'CREATING', ...(excludeId ? { id: { not: excludeId } } : {}) } });
    if (p.maxServers != null && active + creating + 1 > p.maxServers) throw new ConflictException({ code: 'MAX_SERVERS', message: `Se alcanzó el máximo de ${p.maxServers} servidores del proveedor` });
    if (r.priceMonthly != null) {
      const { committedMonthly } = await this.costs(p.id);
      const total = Number(committedMonthly) + r.priceMonthly;
      if (total > Number(p.monthlyBudget)) throw new ConflictException({ code: 'OVER_BUDGET', message: `Con este servidor el gasto mensual sería ${total.toFixed(2)} ${p.currency ?? ''} y el presupuesto es ${p.monthlyBudget.toFixed(2)}` });
    }
  }

  async createRequest(userId: string, input: z.infer<typeof requestSchema>) {
    const p = await this.provider(input.providerId);
    await this.checkRequest(p, input);
    let types;
    try {
      types = await this.adapter(p.kind).serverTypes(this.creds(p));
    } catch (e) {
      this.fail(e);
    }
    const t = types.find((x) => x.name === input.serverType);
    if (!t) throw new BadRequestException({ code: 'UNKNOWN_TYPE', message: `El proveedor no ofrece el tamaño ${input.serverType}` });
    if (t.deprecated) throw new BadRequestException({ code: 'TYPE_DEPRECATED', message: `El tamaño ${t.name} está retirado` });
    if (!t.availableIn.includes(input.location)) throw new BadRequestException({ code: 'NOT_AVAILABLE', message: `${t.name} no está disponible ahora en ${input.location}` });
    const price = t.prices.find((x) => x.location === input.location);
    if (!price) throw new BadRequestException({ code: 'NO_PRICE', message: 'El proveedor no informa el precio para esa región' });
    await this.checkRequest(p, { ...input, priceMonthly: Number(price.monthly.net) });
    const r = await this.db.system.infraServerRequest.create({
      data: {
        providerId: p.id, installationOrderId: input.installationOrderId ?? null, purpose: input.purpose, name: input.name, serverType: t.name, location: input.location,
        image: input.image ?? p.defaultImage, priceHourly: price.hourly.net, priceMonthly: price.monthly.net, currency: p.currency ?? 'EUR', requestedById: userId,
      },
    });
    await this.log(p.id, 'REQUEST', true, { number: r.number, name: r.name, serverType: r.serverType, location: r.location, priceMonthly: price.monthly.net }, userId, { requestId: r.id });
    await this.audit.system({ tenantId: null, userId, action: 'infra.server_requested', entityType: 'infra_server_request', entityId: r.id, metadata: { name: r.name, serverType: r.serverType, location: r.location, priceMonthly: price.monthly.net } });
    return r;
  }

  async reject(userId: string, id: string, note: string, status: 'REJECTED' | 'CANCELLED') {
    const r = await this.db.system.infraServerRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Solicitud no encontrada');
    const u = await this.db.system.infraServerRequest.updateMany({ where: { id, status: 'PENDING_APPROVAL' }, data: { status, decidedById: userId, decidedAt: new Date(), decisionNote: note } });
    if (u.count !== 1) throw new ConflictException({ code: 'REQUEST_CLOSED', message: 'La solicitud ya fue resuelta' });
    await this.log(r.providerId, status === 'REJECTED' ? 'REQUEST_REJECTED' : 'REQUEST_CANCELLED', true, { note }, userId, { requestId: id });
    await this.audit.system({ tenantId: null, userId, action: status === 'REJECTED' ? 'infra.request_rejected' : 'infra.request_cancelled', entityType: 'infra_server_request', entityId: id, metadata: { note } });
    return this.db.system.infraServerRequest.findUnique({ where: { id } });
  }

  /**
   * Aprobar = autorizar el gasto y crear el servidor. Se vuelve a comprobar todo
   * (presupuesto, límites, orden de instalación) y se marca CREATING de forma
   * atómica para que dos aprobaciones no creen dos servidores.
   */
  async approve(userId: string, id: string, input: z.infer<typeof approveSchema>) {
    const r = await this.db.system.infraServerRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Solicitud no encontrada');
    if (r.status !== 'PENDING_APPROVAL') throw new ConflictException({ code: 'REQUEST_CLOSED', message: 'La solicitud ya fue resuelta' });
    if (input.confirmName !== r.name) throw new BadRequestException({ code: 'CONFIRM_NAME', message: `Escribe el nombre exacto del servidor (${r.name}) para aprobar` });
    const p = await this.provider(r.providerId);
    await this.checkRequest(p, { serverType: r.serverType, location: r.location, installationOrderId: r.installationOrderId, priceMonthly: Number(r.priceMonthly) }, id);
    const keys = await this.db.system.infraSshKey.findMany({ where: { isActive: true } });
    if (!keys.length) throw new ConflictException({ code: 'NO_SSH_KEY', message: 'Registra al menos una clave SSH pública: los servidores se crean sin contraseña de root' });
    const lock = await this.db.system.infraServerRequest.updateMany({ where: { id, status: 'PENDING_APPROVAL' }, data: { status: 'CREATING', decidedById: userId, decidedAt: new Date(), decisionNote: input.note ?? null } });
    if (lock.count !== 1) throw new ConflictException({ code: 'REQUEST_CLOSED', message: 'La solicitud ya fue resuelta' });
    await this.audit.system({ tenantId: null, userId, action: 'infra.request_approved', entityType: 'infra_server_request', entityId: id, metadata: { name: r.name, priceMonthly: r.priceMonthly.toFixed(4), currency: r.currency } });

    const a = this.adapter(p.kind);
    const c = this.creds(p);
    const labels = { 'managed-by': 'ai-sales-assistant', request: String(r.number) };
    let step = 'ssh_keys';
    try {
      const keyIds: string[] = [];
      for (const k of keys) keyIds.push((await a.ensureSshKey(c, `aisa-${k.fingerprint.replace(/:/g, '').slice(0, 12)}`, k.publicKey)).externalId);
      step = 'firewall';
      const rules: FirewallRule[] = [
        { direction: 'in', protocol: 'tcp', port: '80', sourceIps: ['0.0.0.0/0', '::/0'], description: 'HTTP (redirige a HTTPS)' },
        { direction: 'in', protocol: 'tcp', port: '443', sourceIps: ['0.0.0.0/0', '::/0'], description: 'HTTPS' },
        { direction: 'in', protocol: 'icmp', sourceIps: ['0.0.0.0/0', '::/0'], description: 'Ping' },
        ...(p.sshSourceCidrs.length ? [{ direction: 'in' as const, protocol: 'tcp' as const, port: '22', sourceIps: p.sshSourceCidrs, description: 'SSH solo desde las direcciones autorizadas' }] : []),
      ];
      const fw = await a.createFirewall(c, `aisa-${r.name}`, rules, labels);
      await this.log(p.id, 'FIREWALL_CREATED', true, { externalId: fw.externalId, rules: rules.map((x) => `${x.protocol}/${x.port ?? '*'} ${x.sourceIps.join(',')}`) }, userId, { requestId: id });
      step = 'user_data';
      const userData = this.userDataProvider ? await this.userDataProvider(id) : undefined;
      step = 'server';
      const created = await a.createServer(c, { name: r.name, serverType: r.serverType, location: r.location, image: r.image, sshKeyIds: keyIds, firewallId: fw.externalId, labels, ...(userData ? { userData } : {}) });
      const s = await this.db.system.$transaction(async (tx) => {
        const s = await tx.infraServer.create({
          data: {
            providerId: p.id, requestId: id, externalId: created.server.externalId, name: created.server.name, status: created.server.status, serverType: r.serverType, location: r.location,
            image: r.image, ipv4: created.server.ipv4, ipv6: created.server.ipv6, firewallExternalId: fw.externalId, priceHourly: r.priceHourly, priceMonthly: r.priceMonthly, currency: r.currency,
            installationOrderId: r.installationOrderId, providerCreatedAt: new Date(created.server.createdAt), lastSyncedAt: new Date(),
          },
        });
        await tx.infraServerRequest.update({ where: { id }, data: { status: 'CREATED' } });
        await tx.infraOperation.create({ data: { providerId: p.id, serverId: s.id, requestId: id, kind: 'SERVER_CREATED', ok: true, userId, detail: { externalId: created.server.externalId, ipv4: created.server.ipv4, action: created.action?.id ?? null, rootPasswordDiscarded: created.rootPasswordReturned } } });
        return s;
      });
      await this.audit.system({ tenantId: null, userId, action: 'infra.server_created', entityType: 'infra_server', entityId: s.id, metadata: { externalId: s.externalId, name: s.name, ipv4: s.ipv4 } });
      return this.server(s.id);
    } catch (e) {
      const msg = e instanceof InfraError ? `${e.message} (${e.code})` : (e as Error).message;
      await this.db.system.infraServerRequest.update({ where: { id }, data: { status: 'FAILED', error: `Paso ${step}: ${msg}` } });
      await this.log(p.id, 'SERVER_CREATE_FAILED', false, { step, error: msg }, userId, { requestId: id });
      this.fail(e);
    }
  }

  // ---------------------------------------------------------------- Servidores

  async servers(includeDeleted = false) {
    return this.db.system.infraServer.findMany({
      where: includeDeleted ? {} : { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { provider: { select: { id: true, label: true, kind: true } }, installationOrder: { select: { id: true, number: true, lead: { select: { id: true, name: true, company: true } } } }, tenant: { select: { id: true, name: true } }, request: { select: { number: true } } },
    });
  }

  async server(id: string) {
    const s = await this.db.system.infraServer.findUnique({
      where: { id },
      include: { provider: { select: { id: true, label: true, kind: true } }, installationOrder: { select: { id: true, number: true, lead: { select: { id: true, name: true, company: true } } } }, tenant: { select: { id: true, name: true } }, request: { select: { id: true, number: true, purpose: true } } },
    });
    if (!s) throw new NotFoundException('Servidor no encontrado');
    const operations = await this.db.system.infraOperation.findMany({ where: { serverId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { ...s, operations };
  }

  private async live(id: string) {
    const s = await this.db.system.infraServer.findUnique({ where: { id }, include: { provider: true } });
    if (!s) throw new NotFoundException('Servidor no encontrado');
    if (s.deletedAt) throw new ConflictException({ code: 'SERVER_DELETED', message: 'El servidor fue eliminado' });
    return s;
  }

  /** Lee el estado, IP y tráfico actuales del proveedor */
  async refresh(userId: string, id: string) {
    const s = await this.live(id);
    let r: RemoteServer | null;
    try {
      r = await this.adapter(s.provider.kind).getServer(this.creds(s.provider), s.externalId);
    } catch (e) {
      this.fail(e);
    }
    if (!r) {
      await this.db.system.infraServer.update({ where: { id }, data: { status: 'missing', lastSyncedAt: new Date() } });
      await this.log(s.providerId, 'SYNC', false, { error: 'El servidor ya no existe en la cuenta del proveedor' }, userId, { serverId: id });
    } else {
      await this.db.system.infraServer.update({ where: { id }, data: { status: r.status, ipv4: r.ipv4, ipv6: r.ipv6, lastSyncedAt: new Date() } });
    }
    return { ...(await this.server(id)), traffic: r?.traffic ?? null };
  }

  async power(userId: string, id: string, action: PowerAction) {
    const s = await this.live(id);
    try {
      const act = await this.adapter(s.provider.kind).power(this.creds(s.provider), s.externalId, action);
      await this.log(s.providerId, `POWER_${action.toUpperCase()}`, act.status !== 'error', { action: act.id, status: act.status, error: act.error }, userId, { serverId: id });
    } catch (e) {
      await this.log(s.providerId, `POWER_${action.toUpperCase()}`, false, { error: (e as Error).message }, userId, { serverId: id });
      this.fail(e);
    }
    await this.audit.system({ tenantId: null, userId, action: 'infra.server_power', entityType: 'infra_server', entityId: id, metadata: { action } });
    return this.refresh(userId, id);
  }

  /** Eliminar: nombre escrito y motivo; queda el registro (la fila no se borra) */
  async remove(userId: string, id: string, input: z.infer<typeof deleteSchema>) {
    const s = await this.live(id);
    if (input.confirmName !== s.name) throw new BadRequestException({ code: 'CONFIRM_NAME', message: `Escribe el nombre exacto del servidor (${s.name}) para eliminarlo` });
    try {
      const act = await this.adapter(s.provider.kind).deleteServer(this.creds(s.provider), s.externalId);
      await this.log(s.providerId, 'SERVER_DELETED', true, { action: act?.id ?? null, reason: input.reason }, userId, { serverId: id });
    } catch (e) {
      if (!(e instanceof InfraError && e.code === 'not_found')) {
        await this.log(s.providerId, 'SERVER_DELETE_FAILED', false, { error: (e as Error).message }, userId, { serverId: id });
        this.fail(e);
      }
      await this.log(s.providerId, 'SERVER_DELETED', true, { note: 'Ya no existía en el proveedor', reason: input.reason }, userId, { serverId: id });
    }
    await this.db.system.infraServer.update({ where: { id }, data: { deletedAt: new Date(), deletedById: userId, deleteReason: input.reason, status: 'deleted' } });
    await this.audit.system({ tenantId: null, userId, action: 'infra.server_deleted', entityType: 'infra_server', entityId: id, metadata: { externalId: s.externalId, name: s.name, reason: input.reason } });
    return this.server(id);
  }

  /** Consumo: CPU y red de las últimas 24 h (lo que el proveedor ofrece) */
  async metrics(id: string) {
    const s = await this.live(id);
    const end = new Date();
    const start = new Date(end.getTime() - 24 * msPerHour);
    try {
      return await this.adapter(s.provider.kind).metrics(this.creds(s.provider), s.externalId, ['cpu', 'network'], start, end);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Órdenes de instalación pagadas sin servidor, para elegir al pedir uno */
  installationOptions() {
    return this.db.system.installationOrder.findMany({
      where: { status: { in: ['AUTHORIZED', 'IN_PROGRESS'] } },
      orderBy: { number: 'desc' },
      select: { id: true, number: true, deploymentMode: true, serverResources: true, lead: { select: { name: true, company: true } } },
    });
  }
}
