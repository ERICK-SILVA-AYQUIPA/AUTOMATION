import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller.js';
import { PlatformMetricsService } from './platform-metrics.service.js';
import { ProvisioningService } from './provisioning.service.js';
import { UsersModule } from '../users/users.module.js';

@Module({ imports: [UsersModule], controllers: [PlatformController], providers: [PlatformMetricsService, ProvisioningService], exports: [PlatformMetricsService] })
export class PlatformModule {}
