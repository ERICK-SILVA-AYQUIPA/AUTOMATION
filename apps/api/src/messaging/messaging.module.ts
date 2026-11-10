import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/whatsapp.module.js';
import { InboundService } from './inbound.service.js';
import { OutboundService } from './outbound.service.js';
import { ConversationsController } from './conversations.controller.js';

@Module({
  imports: [WhatsappModule],
  controllers: [ConversationsController],
  providers: [InboundService, OutboundService],
  exports: [InboundService, OutboundService],
})
export class MessagingModule {}
