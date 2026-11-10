import { Module } from '@nestjs/common';
import { CloudApiClient } from './cloud-api.client.js';
import { WhatsappNumbersService } from './whatsapp-numbers.service.js';
import { WhatsappNumbersController } from './whatsapp.controller.js';
import { WhatsappWebhookController } from './webhook.controller.js';

@Module({
  controllers: [WhatsappNumbersController, WhatsappWebhookController],
  providers: [CloudApiClient, WhatsappNumbersService],
  exports: [CloudApiClient],
})
export class WhatsappModule {}
