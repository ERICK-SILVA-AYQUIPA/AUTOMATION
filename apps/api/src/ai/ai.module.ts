import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { AiController } from './ai.controller.js';
import { AssistantService } from './assistant.service.js';
import { GeminiChatModel } from './gemini.client.js';

@Module({
  imports: [MessagingModule, OrdersModule, ReservationsModule],
  controllers: [AiController],
  providers: [GeminiChatModel, AssistantService],
  exports: [AssistantService, GeminiChatModel],
})
export class AiModule {}
