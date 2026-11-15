import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { CommercialController, PublicCommercialController } from './commercial.controller.js';
import { CommercialService } from './commercial.service.js';

@Module({ imports: [AiModule], controllers: [CommercialController, PublicCommercialController], providers: [CommercialService] })
export class CommercialModule {}
