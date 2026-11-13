import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Tx } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { OrderChannel, ReservationStatus } from '../generated/prisma/enums.js';
import { hhmm, localParts, minutesOf, weekdayOf, zonedToUtc } from '../common/time/zoned.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { readSettings, type TenantSettings } from '../tenants/tenant-settings.js';
import { WebhookEvents } from '../webhooks/webhook-events.service.js';

export interface ReservationActor { tenantId: string; userId: string | null }

export interface CreateReservationInput {
  customerId: string;
  /** Fecha y hora locales de la empresa */
  date: string;
  time: string;
  partySize: number;
  productId?: string | null;
  notes?: string | null;
  channel: OrderChannel;
  conversationId?: string;
  idempotencyKey?: string;
  /** Panel: se crea confirmada. Asistente: depende de la configuración. */
  confirm: boolean;
}

/** Reservas que ocupan capacidad */
const ACTIVE: ReservationStatus[] = ['PENDING', 'CONFIRMED'];
export const RESERVATION_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
  CANCELLED: [],
  COMPLETED: [],
  NO_SHOW: [],
};

export const reservationInclude = {
  customer: { select: { id: true, name: true, phone: true, waProfileName: true } },
} satisfies Prisma.ReservationInclude;

/** Por qué no se puede reservar (mensaje para el panel y para el asistente) */
export class ReservationError extends ConflictException {
  constructor(code: string, message: string) {
    super({ code, message });
  }
}

interface Ctx { settings: TenantSettings['reservations']; timezone: string; currency: string }

/**
 * Reservas de mesa y citas (ADR 043). La capacidad la controla el backend con
 * un bloqueo por empresa: dos reservas simultáneas no pueden pasarse del
 * cupo. Sin horario o sin capacidad configurados no se aceptan reservas.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly inventory: InventoryService,
    private readonly webhooks: WebhookEvents,
  ) {}

  private async ctx(tx: Tx, tenantId: string): Promise<Ctx> {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true, timezone: true, currency: true } });
    return { settings: readSettings(t.settings).reservations, timezone: t.timezone, currency: t.currency };
  }

  /** ¿Qué falta configurar para aceptar reservas? null si está listo */
  static missing(s: TenantSettings['reservations']): string | null {
    if (!s.hours) return 'La empresa aún no configuró el horario de reservas';
    if (!s.capacity) return 'La empresa aún no configuró la capacidad de reservas';
    return null;
  }

  private async service(tx: Tx, tenantId: string, productId: string | null | undefined) {
    if (!productId) return null;
    const p = await tx.product.findFirst({ where: { id: productId, tenantId }, select: { id: true, name: true, status: true, trackStock: true, durationMinutes: true } });
    if (!p) throw new NotFoundException('Servicio no encontrado');
    if (p.status !== 'ACTIVE') throw new ReservationError('SERVICE_UNAVAILABLE', `${p.name} no está disponible`);
    if (p.trackStock) throw new BadRequestException(`${p.name} es un producto con stock, no un servicio reservable`);
    return p;
  }

  /** Ocupación de los intervalos que se solapan con [start, end) */
  private async used(tx: Tx, tenantId: string, s: Ctx['settings'], start: Date, end: Date, excludeId?: string) {
    const rows = await tx.reservation.findMany({
      where: { tenantId, status: { in: ACTIVE }, startsAt: { lt: end }, endsAt: { gt: start }, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { partySize: true },
    });
    return s.kind === 'TABLE' ? rows.reduce((a, r) => a + r.partySize, 0) : rows.length;
  }

  /**
   * Horarios libres de un día. Cada horario respeta el horario de atención
   * (la reserva entera cabe dentro de un turno), la antelación mínima y
   * máxima y la capacidad.
   */
  /** `staff`: el equipo ve también los horarios dentro de la antelación mínima (como al crear desde el panel) */
  async availability(tx: Tx, tenantId: string, q: { date: string; partySize: number; productId?: string | null }, now = new Date(), opts: { staff?: boolean } = {}) {
    const c = await this.ctx(tx, tenantId);
    const s = c.settings;
    const missing = ReservationsService.missing(s);
    if (missing) return { date: q.date, kind: s.kind, slots: [], reason: missing };
    const svc = await this.service(tx, tenantId, q.productId);
    const duration = svc?.durationMinutes ?? s.durationMinutes;
    const need = s.kind === 'TABLE' ? q.partySize : 1;
    if (s.kind === 'TABLE' && q.partySize > s.maxPartySize) return { date: q.date, kind: s.kind, slots: [], reason: `Para más de ${s.maxPartySize} personas coordina directamente con el equipo` };
    const ranges = s.hours![weekdayOf(q.date)] ?? [];
    const slots: { time: string; startsAt: string; remaining: number }[] = [];
    for (const r of ranges) {
      for (let m = minutesOf(r.open); m + duration <= minutesOf(r.close); m += s.slotMinutes) {
        const start = zonedToUtc(q.date, hhmm(m), c.timezone);
        if (opts.staff ? start.getTime() < now.getTime() : !this.withinWindow(s, start, now)) continue;
        const end = new Date(start.getTime() + duration * 60_000);
        const remaining = s.capacity! - (await this.used(tx, tenantId, s, start, end));
        if (remaining >= need) slots.push({ time: hhmm(m), startsAt: start.toISOString(), remaining });
      }
    }
    return { date: q.date, kind: s.kind, durationMinutes: duration, slots, reason: slots.length ? null : 'No hay horarios libres ese día' };
  }

  private withinWindow(s: Ctx['settings'], start: Date, now: Date) {
    const t = start.getTime();
    return t >= now.getTime() + s.minNoticeMinutes * 60_000 && t <= now.getTime() + s.maxDaysAhead * 86_400_000;
  }

  async create(actor: ReservationActor, input: CreateReservationInput) {
    if (input.idempotencyKey) {
      const existing = await this.findByKey(actor.tenantId, input.idempotencyKey);
      if (existing) return { reservation: existing, created: false };
    }
    try {
      const reservation = await this.db.tenant(actor.tenantId, (tx) => this.createInTx(tx, actor, input));
      return { reservation, created: true };
    } catch (e) {
      if (input.idempotencyKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.findByKey(actor.tenantId, input.idempotencyKey);
        if (existing) return { reservation: existing, created: false };
      }
      throw e;
    }
  }

  private findByKey(tenantId: string, key: string) {
    return this.db.tenant(tenantId, (tx) => tx.reservation.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } }, include: reservationInclude }));
  }

  async createInTx(tx: Tx, actor: ReservationActor, input: CreateReservationInput, now = new Date()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new BadRequestException('Fecha u hora no válidas');
    // Las reservas de la empresa se crean en serie: el cupo no se puede pasar con dos peticiones a la vez
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reservations:${actor.tenantId}`}))`;
    const c = await this.ctx(tx, actor.tenantId);
    const s = c.settings;
    const missing = ReservationsService.missing(s);
    if (missing) throw new ReservationError('RESERVATIONS_NOT_CONFIGURED', missing);
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, tenantId: actor.tenantId }, select: { id: true, name: true, waProfileName: true, phone: true } });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    const svc = await this.service(tx, actor.tenantId, input.productId);
    if (s.kind === 'APPOINTMENT' && input.partySize !== 1) throw new BadRequestException('Una cita es para una persona');
    if (input.partySize < 1 || input.partySize > s.maxPartySize) throw new ReservationError('PARTY_TOO_LARGE', `Máximo ${s.maxPartySize} personas por reserva`);

    const duration = svc?.durationMinutes ?? s.durationMinutes;
    const start = zonedToUtc(input.date, input.time, c.timezone);
    const end = new Date(start.getTime() + duration * 60_000);
    const fits = (s.hours![weekdayOf(input.date)] ?? []).some((r) => minutesOf(r.open) <= minutesOf(input.time) && minutesOf(input.time) + duration <= minutesOf(r.close));
    if (!fits) throw new ReservationError('OUTSIDE_HOURS', 'Ese horario está fuera del horario de reservas');
    if (start.getTime() < now.getTime()) throw new ReservationError('IN_THE_PAST', 'Ese horario ya pasó');
    // El equipo puede saltarse la antelación mínima; el asistente no
    if (input.channel === 'WHATSAPP' && !this.withinWindow(s, start, now)) {
      throw new ReservationError('OUTSIDE_WINDOW', `Se reserva con al menos ${s.minNoticeMinutes} minutos y hasta ${s.maxDaysAhead} días de anticipación`);
    }
    const need = s.kind === 'TABLE' ? input.partySize : 1;
    const used = await this.used(tx, actor.tenantId, s, start, end);
    if (used + need > s.capacity!) throw new ReservationError('SLOT_FULL', 'Ese horario ya no tiene cupo');

    const [counter] = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO tenant_counters (tenant_id, key, value) VALUES (${actor.tenantId}::uuid, 'reservation_number', 1)
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = tenant_counters.value + 1
      RETURNING value`;
    const status: ReservationStatus = input.confirm || !s.requireConfirmation ? 'CONFIRMED' : 'PENDING';
    const r = await tx.reservation.create({
      data: {
        tenantId: actor.tenantId, number: counter!.value, customerId: customer.id, branchId: await this.inventory.defaultBranchId(tx, actor.tenantId),
        conversationId: input.conversationId, productId: svc?.id ?? null, serviceName: svc?.name ?? null,
        startsAt: start, endsAt: end, partySize: input.partySize, status, channel: input.channel, notes: input.notes ?? null,
        idempotencyKey: input.idempotencyKey, createdById: actor.userId, confirmedAt: status === 'CONFIRMED' ? now : null,
      },
      include: reservationInclude,
    });
    const who = customer.name ?? customer.waProfileName ?? (customer.phone ? `+${customer.phone}` : 'Cliente');
    if (input.channel === 'WHATSAPP') {
      await tx.notification.create({
        data: {
          tenantId: actor.tenantId, type: 'reservation.created', title: `Reserva #${r.number} por WhatsApp`,
          body: `${who}: ${input.date} ${input.time}${s.kind === 'TABLE' ? `, ${input.partySize} persona(s)` : ''}${svc ? `, ${svc.name}` : ''}.${status === 'PENDING' ? ' Confírmala o anúlala en Reservas.' : ''}`,
          data: { reservationId: r.id },
        },
      });
    }
    await this.webhooks.emit(tx, actor.tenantId, 'reservation.created', {
      reservationId: r.id, number: r.number, status, channel: input.channel, startsAt: start.toISOString(), endsAt: end.toISOString(),
      partySize: input.partySize, service: svc ? { id: svc.id, name: svc.name } : null, customer: { id: customer.id, name: customer.name ?? customer.waProfileName ?? null, phone: customer.phone ?? null },
    });
    return r;
  }

  transition(actor: ReservationActor, id: string, to: ReservationStatus, note: string | null) {
    return this.db.tenant(actor.tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<{ status: ReservationStatus }[]>`SELECT status FROM reservations WHERE id = ${id}::uuid AND tenant_id = ${actor.tenantId}::uuid FOR UPDATE`;
      if (!row) throw new NotFoundException('Reserva no encontrada');
      if (row.status !== to) {
        if (!RESERVATION_TRANSITIONS[row.status].includes(to)) throw new ConflictException({ code: 'INVALID_TRANSITION', message: `No se puede pasar de ${row.status} a ${to}` });
        const now = new Date();
        await tx.reservation.update({
          where: { id },
          data: { status: to, ...(to === 'CONFIRMED' ? { confirmedAt: now } : {}), ...(to === 'CANCELLED' ? { cancelledAt: now } : {}), ...(note ? { notes: note } : {}) },
        });
        const r = await tx.reservation.findUniqueOrThrow({ where: { id }, select: { number: true } });
        await this.webhooks.emit(tx, actor.tenantId, 'reservation.status_changed', { reservationId: id, number: r.number, from: row.status, to, note });
      }
      return tx.reservation.findUniqueOrThrow({ where: { id }, include: reservationInclude });
    });
  }

  /** Texto local de la reserva (para el asistente y los recordatorios) */
  static describe(r: { startsAt: Date }, timezone: string) {
    const p = localParts(r.startsAt, timezone);
    return { date: p.date, time: p.time };
  }
}
