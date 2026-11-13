import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { Principal } from '../common/context/principal.js';
import { CurrentUser, RequirePermission } from '../common/decorators/auth.decorators.js';
import { DeliveriesService, createDeliverySchema, type CreateDeliveryInput } from './deliveries.service.js';

/** Entrega de sistemas (ADR 044): solo el ADMINISTRADOR GENERAL */
@RequirePermission('platform:manage')
@Controller('platform')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get('tenants/:id/deliveries')
  list(@Param('id', { schema: z.uuid() }) id: string) {
    return this.deliveries.list(id);
  }

  @Post('tenants/:id/deliveries')
  create(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: createDeliverySchema }) b: CreateDeliveryInput) {
    return this.deliveries.create(p.userId, id, b);
  }

  @Get('deliveries/:id')
  get(@Param('id', { schema: z.uuid() }) id: string) {
    return this.deliveries.get(id);
  }

  @Post('deliveries/:id/refresh')
  @HttpCode(200)
  refresh(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string) {
    return this.deliveries.refresh(p.userId, id);
  }

  /** ZIP reproducible; la huella va en X-Package-Sha256 */
  @Get('deliveries/:id/package')
  async package(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string, @Res() res: Response) {
    const r = await this.deliveries.package(p.userId, id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    res.setHeader('X-Package-Sha256', r.sha256);
    res.setHeader('Cache-Control', 'no-store');
    res.end(r.buffer);
  }

  @Post('deliveries/:id/delivered')
  @HttpCode(200)
  delivered(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string) {
    return this.deliveries.markDelivered(p.userId, id);
  }
}
