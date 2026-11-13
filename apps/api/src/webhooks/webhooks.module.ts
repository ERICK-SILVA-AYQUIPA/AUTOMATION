import { Global, Module } from '@nestjs/common';
import { WebhookEvents } from './webhook-events.service.js';
import { WebhookSender } from './webhook-sender.js';

@Global()
@Module({ providers: [WebhookEvents, WebhookSender], exports: [WebhookEvents, WebhookSender] })
export class WebhooksModule {}
