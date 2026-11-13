import { PlatformMetricsService } from './platform-metrics.service.js';
import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller.js';

@Module({ controllers: [PlatformController], providers: [PlatformMetricsService], exports: [PlatformMetricsService] })
export class PlatformModule {}
