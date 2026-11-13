import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../users/users.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { MODULES } from '../common/decorators/module.decorator.js';
import { tenantProfileSchema } from '../tenants/tenants.controller.js';
import { bootstrapTenant, slugify, uniqueSlug } from '../tenants/tenant-bootstrap.js';
import { computeOnboarding } from '../tenants/onboarding.js';

const DAY = 86_400_000;
const domain = z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Dominio no válido').max(253);

/** Alta completa de una empresa desde el panel general (asistente de alta). */
export const provisionSchema = tenantProfileSchema
  .partial({ legalName: true, taxId: true, address: true, phone: true, contactEmail: true, logoUrl: true, brandColor: true })
  .extend({
    /** La genera el asistente al empezar: repetir el envío devuelve la misma empresa */
    idempotencyKey: z.uuid(),
    customDomain: domain.nullable().optional(),
    deploymentMode: z.enum(['SAAS', 'DEDICATED', 'CUSTOM']),
    enabledModules: z.array(z.enum(MODULES)).min(1).max(MODULES.length),
    planCode: z.enum(['BASIC', 'PROFESSIONAL', 'ENTERPRISE']),
    /** Periodo inicial (prueba o cortesía acordada). El pago se registra aparte en «Cobro». */
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date(),
    admin: z.object({ name: z.string().trim().min(2).max(120), email: z.email().max(200).transform((e) => e.toLowerCase()) }),
  })
  .refine((v) => !(v.country === 'PE' && v.taxId && !/^(10|15|17|20)\d{9}$/.test(v.taxId)), { message: 'El RUC debe tener 11 dígitos y empezar por 10, 15, 17 o 20', path: ['taxId'] });
export type ProvisionInput = z.infer<typeof provisionSchema>;

export interface ProvisionResult {
  tenant: { id: string; name: string; slug: string; status: string };
  created: boolean;
  invitation: { sent: boolean; error?: string };
}

@Injectable()
export class ProvisioningService {
  private readonly log = new Logger('Provisioning');

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly users: UsersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async provision(actorId: string, input: ProvisionInput): Promise<ProvisionResult> {
    const replay = await this.byKey(input.idempotencyKey);
    if (replay) return { tenant: replay, created: false, invitation: { sent: false } };

    const now = new Date();
    const startsAt = input.startsAt ?? now;
    if (startsAt.getTime() > now.getTime() + DAY) throw new BadRequestException('El periodo no puede empezar en el futuro');
    if (input.endsAt.getTime() <= Math.max(startsAt.getTime(), now.getTime())) throw new BadRequestException('La fecha de fin debe ser posterior a hoy');
    if (input.endsAt.getTime() - startsAt.getTime() > 366 * DAY) throw new BadRequestException('El periodo inicial no puede pasar de un año');

    const plan = await this.db.system.plan.findUnique({ where: { code: input.planCode } });
    if (!plan?.isActive) throw new BadRequestException('Ese plan no está disponible');
    const taken = await this.db.system.user.findUnique({ where: { email: input.admin.email }, select: { id: true } });
    if (taken) throw new ConflictException('Ese correo ya está registrado en la plataforma');

    const { idempotencyKey, admin, planCode: _plan, startsAt: _s, endsAt, enabledModules, ...profile } = input;
    let result: { tenant: ProvisionResult['tenant']; adminId: string };
    try {
      result = await this.db.system.$transaction(async (tx) => {
        const slug = await uniqueSlug(tx, slugify(profile.name));
        const tenant = await tx.tenant.create({
          data: { ...profile, slug, status: 'ONBOARDING', provisioningKey: idempotencyKey, enabledModules: [...new Set(enabledModules)] },
          select: { id: true, name: true, slug: true, status: true },
        });
        await tx.subscription.create({
          data: { tenantId: tenant.id, planId: plan.id, status: 'TRIALING', trialEndsAt: endsAt, currentPeriodStart: startsAt, currentPeriodEnd: endsAt },
        });
        await bootstrapTenant(tx, tenant.id);
        const user = await tx.user.create({ data: { tenantId: tenant.id, email: admin.email, name: admin.name, role: 'TENANT_ADMIN', status: 'INVITED' }, select: { id: true } });
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id, userId: actorId, action: 'platform.tenant_provisioned', entityType: 'tenant', entityId: tenant.id,
            metadata: { planCode: input.planCode, deploymentMode: profile.deploymentMode, enabledModules, startsAt, endsAt, adminEmail: admin.email },
          },
        });
        return { tenant, adminId: user.id };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Dos envíos simultáneos del mismo asistente: gana uno y el otro recibe la misma empresa
        const again = await this.byKey(idempotencyKey);
        if (again) return { tenant: again, created: false, invitation: { sent: false } };
        // Con el adaptador de pg el índice llega dentro de meta; se busca el nombre de la columna
        const target = JSON.stringify(e.meta ?? {});
        if (target.includes('custom_domain')) throw new BadRequestException('Ese dominio ya lo usa otra empresa');
        if (target.includes('email')) throw new ConflictException('Ese correo ya está registrado en la plataforma');
      }
      throw e;
    }

    // Fuera de la transacción: si el correo falla, la empresa ya existe y la
    // invitación se reenvía desde la ficha (la lista de tareas lo muestra).
    const invitation = await this.invite(result.tenant.id, result.adminId, admin.email, admin.name);
    return { tenant: result.tenant, created: true, invitation };
  }

  /** Reenvía la invitación a los administradores que aún no entraron. */
  async resendInvitations(tenantId: string) {
    const admins = await this.db.system.user.findMany({ where: { tenantId, role: 'TENANT_ADMIN', status: 'INVITED' }, select: { id: true, email: true, name: true } });
    if (!admins.length) throw new BadRequestException('No hay administradores pendientes de aceptar la invitación');
    const results = [];
    for (const a of admins) results.push({ email: a.email, ...(await this.invite(tenantId, a.id, a.email, a.name)) });
    return results;
  }

  onboarding(tenantId: string) {
    return this.db.system.$transaction((tx) =>
      computeOnboarding(tx, tenantId, { graceDays: this.env.BILLING_GRACE_DAYS, aiProviderConfigured: !!this.env.GEMINI_API_KEY, checkInvitations: true }),
    );
  }

  /** Pone en marcha la empresa solo si todas las tareas obligatorias están hechas. */
  async activate(actorId: string, tenantId: string) {
    const exists = await this.db.system.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Empresa no encontrada');
    const ob = await this.onboarding(tenantId);
    if (ob.status !== 'ONBOARDING') throw new BadRequestException('La empresa no está en preparación');
    if (!ob.canActivate) {
      throw new ConflictException({ code: 'ONBOARDING_INCOMPLETE', message: 'Faltan tareas obligatorias', pending: ob.tasks.filter((t) => t.required && !t.done).map((t) => t.label) });
    }
    const r = await this.db.system.tenant.updateMany({ where: { id: tenantId, status: 'ONBOARDING' }, data: { status: 'ACTIVE', activatedAt: new Date() } });
    if (r.count === 1) {
      await this.db.system.notification.create({ data: { tenantId, type: 'tenant.activated', title: 'Tu cuenta está activa', body: 'La plataforma activó tu empresa: el asistente ya puede responder a tus clientes por WhatsApp.', data: {} } });
      await this.audit.system({ tenantId, userId: actorId, action: 'platform.tenant_activated', entityType: 'tenant', entityId: tenantId, metadata: {} });
    }
    return this.onboarding(tenantId);
  }

  private byKey(key: string) {
    return this.db.system.tenant.findUnique({ where: { provisioningKey: key }, select: { id: true, name: true, slug: true, status: true } });
  }

  private async invite(tenantId: string, userId: string, email: string, name: string): Promise<{ sent: boolean; error?: string }> {
    try {
      await this.users.sendInvitation(userId, email, name);
      await this.audit.system({ tenantId, userId: null, action: 'platform.admin_invited', entityType: 'user', entityId: userId, metadata: { email } });
      return { sent: true };
    } catch (e) {
      // Sin correo enviado no debe quedar una invitación "vigente" que nadie recibió
      await this.db.system.authToken.deleteMany({ where: { userId, type: 'INVITATION', usedAt: null } });
      const error = e instanceof Error ? e.message : String(e);
      this.log.error(`No se pudo enviar la invitación de ${tenantId}: ${error}`);
      return { sent: false, error: 'No se pudo enviar el correo de invitación. Revisa el SMTP y reenvíala desde la ficha.' };
    }
  }
}
