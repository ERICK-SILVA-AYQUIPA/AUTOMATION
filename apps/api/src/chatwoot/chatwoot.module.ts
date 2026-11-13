import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module.js';
import { ChatwootClient } from './chatwoot.client.js';
import { ChatwootService } from './chatwoot.service.js';
import { ChatwootSyncService } from './chatwoot-sync.service.js';
import { ChatwootWebhookController, ChatwootWebhookService } from './chatwoot-webhook.controller.js';
import { ChatwootController } from './chatwoot.controller.js';

@Module({
  imports: [MessagingModule],
  controllers: [ChatwootController, ChatwootWebhookController],
  providers: [ChatwootClient, ChatwootService, ChatwootSyncService, ChatwootWebhookService],
  exports: [ChatwootService, ChatwootSyncService, ChatwootClient],
})
export class ChatwootModule {}
