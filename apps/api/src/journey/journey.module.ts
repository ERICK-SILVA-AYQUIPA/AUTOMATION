import { Module } from '@nestjs/common';
import { JourneyController } from './journey.controller.js';
import { JourneyService } from './journey.service.js';

@Module({ controllers: [JourneyController], providers: [JourneyService] })
export class JourneyModule {}
