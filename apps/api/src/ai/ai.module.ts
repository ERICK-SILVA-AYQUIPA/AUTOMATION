import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { AiController } from './ai.controller.js';
import { AssistantService } from './assistant.service.js';
import { AiCenter } from './center/ai-center.service.js';
import { AiRouter } from './center/ai-router.service.js';
import { CredentialVault } from './center/credential-vault.service.js';
import { ModelCatalog } from './center/model-catalog.service.js';
import { GeminiChatModel } from './gemini.client.js';
import { AnthropicAdapter } from './providers/anthropic.adapter.js';
import { DeepSeekAdapter, OpenAiAdapter } from './providers/openai-compatible.adapter.js';
import { AiProviders } from './providers/registry.js';

@Module({
  imports: [MessagingModule, OrdersModule, ReservationsModule],
  controllers: [AiController],
  providers: [GeminiChatModel, AnthropicAdapter, OpenAiAdapter, DeepSeekAdapter, AiProviders, CredentialVault, ModelCatalog, AiRouter, AiCenter, AssistantService],
  exports: [AssistantService, GeminiChatModel, AiProviders, CredentialVault, ModelCatalog, AiRouter, AiCenter],
})
export class AiModule {}
