import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '../common/context/principal.js';
import { CurrentUser, RequirePermission } from '../common/decorators/auth.decorators.js';
import {
  SalesService, activitySchema, createLeadSchema, listSchema, nextActionDoneSchema, nextActionSchema, ownerSchema, paymentSchema, statusSchema, updateLeadSchema,
  type CreateLeadInput, type ListInput, type UpdateLeadInput,
} from './sales.service.js';

const id = { schema: z.uuid() };
const boardSchema = listSchema.pick({ ownerId: true, source: true, sector: true, q: true });

/** Centro comercial (ADR 047): solo el personal de la plataforma */
@RequirePermission('platform:manage')
@Controller('platform/sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get('owners')
  owners() {
    return this.sales.owners();
  }

  @Get('summary')
  summary() {
    return this.sales.summary();
  }

  @Get('board')
  board(@Query({ schema: boardSchema }) q: z.infer<typeof boardSchema>) {
    return this.sales.board(q);
  }

  @Get('leads')
  list(@Query({ schema: listSchema }) q: ListInput) {
    return this.sales.list(q);
  }

  @Post('leads')
  create(@CurrentUser() p: Principal, @Body({ schema: createLeadSchema }) b: CreateLeadInput) {
    return this.sales.create(p.userId, b);
  }

  @Get('leads/:id')
  get(@Param('id', id) leadId: string) {
    return this.sales.get(leadId);
  }

  @Patch('leads/:id')
  update(@CurrentUser() p: Principal, @Param('id', id) leadId: string, @Body({ schema: updateLeadSchema }) b: UpdateLeadInput) {
    return this.sales.update(p.userId, leadId, b);
  }

  @Post('leads/:id/status')
  @HttpCode(200)
  status(@CurrentUser() p: Principal, @Param('id', id) leadId: string, @Body({ schema: statusSchema }) b: z.infer<typeof statusSchema>) {
    return this.sales.setStatus(p.userId, leadId, b);
  }

  @Post('leads/:id/owner')
  @HttpCode(200)
  owner(@CurrentUser() p: Principal, @Param('id', id) leadId: string, @Body({ schema: ownerSchema }) b: z.infer<typeof ownerSchema>) {
    return this.sales.setOwner(p.userId, leadId, b.ownerId);
  }

  @Put('leads/:id/next-action')
  nextAction(@CurrentUser() p: Principal, @Param('id', id) leadId: string, @Body({ schema: nextActionSchema }) b: z.infer<typeof nextActionSchema>) {
    return this.sales.setNextAction(p.userId, leadId, b);
  }

  @Post('leads/:id/next-action/done')
  @HttpCode(200)
  nextActionDone(@CurrentUser() p: Principal, @Param('id', id) leadId: string, @Body({ schema: nextActionDoneSchema }) b: z.infer<typeof nextActionDoneSchema>) {
    return this.sales.completeNextAction(p.userId, leadId, b.note);
  }

  @Post('leads/:id/activities')
  activity(@CurrentUser() p: Principal, @Param('id', id) leadId: string, @Body({ schema: activitySchema }) b: z.infer<typeof activitySchema>) {
    return this.sales.addActivity(p.userId, leadId, b);
  }

  @Post('leads/:id/payment')
  @HttpCode(200)
  payment(@CurrentUser() p: Principal, @Param('id', id) leadId: string, @Body({ schema: paymentSchema }) b: z.infer<typeof paymentSchema>) {
    return this.sales.validatePayment(p.userId, leadId, b);
  }

  @Get('leads/:id/conversion')
  conversion(@Param('id', id) leadId: string) {
    return this.sales.conversionDraft(leadId);
  }
}
