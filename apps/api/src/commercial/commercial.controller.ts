import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import type { Principal } from '../common/context/principal.js';
import { CurrentUser, Public, RequirePermission } from '../common/decorators/auth.decorators.js';
import { CommercialService, agentTestSchema, chatMessageSchema, publicLeadSchema, type PublicLeadInput } from './commercial.service.js';
import { updateCommercialSchema, type UpdateCommercialInput } from './settings.js';

const id = { schema: z.uuid() };

/** Configuración de la página y del agente comercial: solo el personal de la plataforma */
@RequirePermission('platform:manage')
@Controller('platform/commercial')
export class CommercialController {
  constructor(private readonly commercial: CommercialService) {}

  @Get()
  settings() {
    return this.commercial.settings();
  }

  @Put()
  update(@CurrentUser() p: Principal, @Body({ schema: updateCommercialSchema }) b: UpdateCommercialInput) {
    return this.commercial.update(p.userId, b);
  }

  @Post('agent/test')
  @HttpCode(200)
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  test(@Body({ schema: agentTestSchema }) b: z.infer<typeof agentTestSchema>) {
    return this.commercial.testAgent(b.messages);
  }

  @Get('leads/:id/chats')
  chats(@Param('id', id) leadId: string) {
    return this.commercial.chatsOfLead(leadId);
  }
}

/** Página comercial pública: sin sesión y con límites por IP */
@Public()
@Controller('public')
export class PublicCommercialController {
  constructor(private readonly commercial: CommercialService) {}

  @Get('commercial')
  content() {
    return this.commercial.publicContent();
  }

  @Post('leads')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  lead(@Req() req: Request, @Body({ schema: publicLeadSchema }) b: PublicLeadInput) {
    return this.commercial.submitPublicLead(b, req.ip ?? null);
  }

  @Post('chat')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  start() {
    return this.commercial.startChat();
  }

  @Post('chat/:id/messages')
  @HttpCode(200)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  message(@Param('id', id) sessionId: string, @Body({ schema: chatMessageSchema }) b: z.infer<typeof chatMessageSchema>) {
    return this.commercial.chat(sessionId, b.token, b.text);
  }
}
