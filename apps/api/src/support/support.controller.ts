import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Principal, TenantPrincipal } from '../common/context/principal.js';
import { CurrentUser, RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import { RenewalsService } from './renewals.service.js';
import {
  SupportService, createTicketSchema, listSchema, messageSchema, rateSchema, staffMessageSchema, staffTicketSchema, updateTicketSchema,
} from './support.service.js';

const id = { schema: z.uuid() };

/** Soporte desde el panel de la empresa (ADR 054) */
@RequirePermission('support:use')
@Controller('support')
export class SupportController {
  constructor(private readonly s: SupportService) {}

  @Get('info')
  info(@TenantUser() p: TenantPrincipal) {
    return this.s.info(p.tenantId);
  }
  @Get('tickets')
  list(@TenantUser() p: TenantPrincipal) {
    return this.s.listOwn(p.tenantId);
  }
  @Post('tickets')
  create(@TenantUser() p: TenantPrincipal, @Body({ schema: createTicketSchema }) b: z.infer<typeof createTicketSchema>) {
    return this.s.create(p.tenantId, p.userId, b);
  }
  @Get('tickets/:id')
  get(@TenantUser() p: TenantPrincipal, @Param('id', id) tid: string) {
    return this.s.getOwn(p.tenantId, tid);
  }
  @Post('tickets/:id/messages')
  @HttpCode(200)
  reply(@TenantUser() p: TenantPrincipal, @Param('id', id) tid: string, @Body({ schema: messageSchema }) b: z.infer<typeof messageSchema>) {
    return this.s.replyOwn(p.tenantId, p.userId, tid, b);
  }
  @Post('tickets/:id/rating')
  @HttpCode(200)
  rate(@TenantUser() p: TenantPrincipal, @Param('id', id) tid: string, @Body({ schema: rateSchema }) b: z.infer<typeof rateSchema>) {
    return this.s.rate(p.tenantId, p.userId, tid, b);
  }
}

/** Centro de soporte y renovaciones del equipo de la plataforma (ADR 054) */
@RequirePermission('platform:manage')
@Controller('platform/support')
export class PlatformSupportController {
  constructor(
    private readonly s: SupportService,
    private readonly renewals: RenewalsService,
  ) {}

  @Get('summary')
  summary() {
    return this.s.summary();
  }
  @Get('tickets')
  list(@Query({ schema: listSchema }) q: z.infer<typeof listSchema>) {
    return this.s.list(q);
  }
  @Post('tickets')
  create(@CurrentUser() p: Principal, @Body({ schema: staffTicketSchema }) b: z.infer<typeof staffTicketSchema>) {
    return this.s.createForTenant(p.userId, b);
  }
  @Get('tickets/:id')
  get(@Param('id', id) tid: string) {
    return this.s.get(tid);
  }
  @Post('tickets/:id/messages')
  @HttpCode(200)
  reply(@CurrentUser() p: Principal, @Param('id', id) tid: string, @Body({ schema: staffMessageSchema }) b: z.infer<typeof staffMessageSchema>) {
    return this.s.reply(p.userId, tid, b);
  }
  @Patch('tickets/:id')
  update(@CurrentUser() p: Principal, @Param('id', id) tid: string, @Body({ schema: updateTicketSchema }) b: z.infer<typeof updateTicketSchema>) {
    return this.s.update(p.userId, tid, b);
  }
  @Get('renewals')
  renewalsList() {
    return this.renewals.list();
  }
  /** Lo mismo que hace el worker cada hora; idempotente: un aviso por periodo y tipo */
  @Post('renewals/send')
  @HttpCode(200)
  async sendNow() {
    return { sent: await this.renewals.sendNotices() };
  }
}
