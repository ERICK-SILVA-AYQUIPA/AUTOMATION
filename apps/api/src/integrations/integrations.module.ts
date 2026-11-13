import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { ChatwootModule } from '../chatwoot/chatwoot.module.js';
import { WhatsappModule } from '../whatsapp/whatsapp.module.js';
import { WebhooksController } from '../webhooks/webhooks.controller.js';
import { IntegrationChecks } from './integration-checks.service.js';
import { IntegrationsController } from './integrations.controller.js';
import { PlatformIntegrationsController } from './platform-integrations.controller.js';

/** Centro de integraciones: empresa y plataforma (solo en la API) */
@Module({
  imports: [AiModule, ChatwootModule, WhatsappModule],
  controllers: [IntegrationsController, WebhooksController, PlatformIntegrationsController],
  providers: [IntegrationChecks],
})
export class IntegrationsModule {}
