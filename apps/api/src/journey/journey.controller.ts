import { Controller, Get, Param } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../common/decorators/auth.decorators.js';
import { JourneyService } from './journey.service.js';

/** Asistente «Nueva venta e instalación» (ADR 053): solo el equipo de la plataforma */
@RequirePermission('platform:manage')
@Controller('platform/journey')
export class JourneyController {
  constructor(private readonly j: JourneyService) {}

  @Get()
  list() {
    return this.j.list();
  }
  @Get(':leadId')
  get(@Param('leadId', { schema: z.uuid() }) id: string) {
    return this.j.get(id);
  }
}
