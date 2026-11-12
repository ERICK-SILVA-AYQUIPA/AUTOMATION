import { Controller, Get, Post } from '@nestjs/common';
import { AllowWhenReadOnly, RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { ChatwootService } from './chatwoot.service.js';

@Controller('integrations/chatwoot')
export class ChatwootController {
  constructor(private readonly chatwoot: ChatwootService) {}

  @RequirePermission('conversations:read')
  @Get()
  get(@TenantUser() p: TenantPrincipal) {
    return this.chatwoot.get(p);
  }

  @RequirePermission('integrations:manage')
  @Post('connect')
  connect(@TenantUser() p: TenantPrincipal) {
    return this.chatwoot.connect(p);
  }

  /** Enlace de inicio de sesión único en Chatwoot para el usuario actual.
   *  Permitido en solo lectura para consultar el historial; las respuestas de los
   *  agentes se bloquean al enviarlas (OutboundService). */
  @AllowWhenReadOnly()
  @RequirePermission('conversations:reply')
  @Post('sso')
  sso(@TenantUser() p: TenantPrincipal) {
    return this.chatwoot.sso(p);
  }
}
