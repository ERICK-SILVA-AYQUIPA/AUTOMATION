import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '../common/context/principal.js';
import { CurrentUser, RequirePermission } from '../common/decorators/auth.decorators.js';
import { FinanceService, budgetSchema, costItemSchema, endCostSchema, periodSchema, settingsSchema } from './finance.service.js';

const id = { schema: z.uuid() };
const scope = { schema: z.enum(['AI', 'TOTAL']) };

/** Rentabilidad por instalación, presupuestos y alertas de consumo (ADR 055). Solo la plataforma */
@RequirePermission('platform:manage')
@Controller('platform/finance')
export class FinanceController {
  constructor(private readonly f: FinanceService) {}

  @Get()
  overview(@Query({ schema: periodSchema }) q: z.infer<typeof periodSchema>) {
    return this.f.overview(q.period);
  }
  @Get('settings')
  settings() {
    return this.f.settings();
  }
  @Put('settings')
  saveSettings(@CurrentUser() p: Principal, @Body({ schema: settingsSchema }) b: z.infer<typeof settingsSchema>) {
    return this.f.saveSettings(p.userId, b);
  }
  @Get('tenants/:id')
  async tenant(@Param('id', id) tenantId: string, @Query({ schema: periodSchema }) q: z.infer<typeof periodSchema>) {
    return { ...(await this.f.tenantReport(tenantId, q.period)), alerts: await this.f.alerts(tenantId) };
  }
  @Post('tenants/:id/costs')
  addCost(@CurrentUser() p: Principal, @Param('id', id) tenantId: string, @Body({ schema: costItemSchema }) b: z.infer<typeof costItemSchema>) {
    return this.f.addCost(p.userId, tenantId, b);
  }
  @Patch('tenants/:id/costs/:costId')
  endCost(@CurrentUser() p: Principal, @Param('id', id) tenantId: string, @Param('costId', id) costId: string, @Body({ schema: endCostSchema }) b: z.infer<typeof endCostSchema>) {
    return this.f.endCost(p.userId, tenantId, costId, b);
  }
  @Put('tenants/:id/budgets/:scope')
  setBudget(@CurrentUser() p: Principal, @Param('id', id) tenantId: string, @Param('scope', scope) s: 'AI' | 'TOTAL', @Body({ schema: budgetSchema }) b: z.infer<typeof budgetSchema>) {
    return this.f.setBudget(p.userId, tenantId, s, b);
  }
  @Delete('tenants/:id/budgets/:scope')
  removeBudget(@CurrentUser() p: Principal, @Param('id', id) tenantId: string, @Param('scope', scope) s: 'AI' | 'TOTAL') {
    return this.f.removeBudget(p.userId, tenantId, s);
  }
  /** Lo mismo que hace el worker cada hora; idempotente */
  @Post('alerts/check')
  @HttpCode(200)
  async check() {
    return { sent: await this.f.checkBudgets() };
  }
}
