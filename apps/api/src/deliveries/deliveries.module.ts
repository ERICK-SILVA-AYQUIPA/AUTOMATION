import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { DeliveriesController } from './deliveries.controller.js';
import { DeliveriesService } from './deliveries.service.js';

@Module({ imports: [IntegrationsModule], controllers: [DeliveriesController], providers: [DeliveriesService] })
export class DeliveriesModule {}
