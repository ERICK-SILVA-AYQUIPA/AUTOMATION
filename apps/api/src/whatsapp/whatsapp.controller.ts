import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { createCloudNumberSchema, testMessageSchema, updateNumberSchema, WhatsappNumbersService } from './whatsapp-numbers.service.js';

const uuid = { schema: z.uuid() };

@RequirePermission('integrations:manage')
@Controller('whatsapp/numbers')
export class WhatsappNumbersController {
  constructor(private readonly numbers: WhatsappNumbersService) {}

  @Get()
  list(@TenantUser() p: TenantPrincipal) {
    return this.numbers.list(p);
  }

  @Post()
  create(@TenantUser() p: TenantPrincipal, @Body({ schema: createCloudNumberSchema }) b: z.infer<typeof createCloudNumberSchema>) {
    return this.numbers.createCloud(p, b);
  }

  @Patch(':id')
  update(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @Body({ schema: updateNumberSchema }) b: z.infer<typeof updateNumberSchema>) {
    return this.numbers.update(p, id, b);
  }

  @Get(':id/webhook')
  webhook(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    return this.numbers.webhookConfig(p, id);
  }

  @Post(':id/check')
  check(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    return this.numbers.check(p, id);
  }

  @Post(':id/test-message')
  test(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @Body({ schema: testMessageSchema }) b: z.infer<typeof testMessageSchema>) {
    return this.numbers.sendTestTemplate(p, id, b);
  }
}
