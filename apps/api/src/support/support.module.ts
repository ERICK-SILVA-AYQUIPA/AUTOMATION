import { Module } from '@nestjs/common';
import { RenewalsService } from './renewals.service.js';
import { PlatformSupportController, SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';

@Module({ controllers: [SupportController, PlatformSupportController], providers: [SupportService, RenewalsService], exports: [SupportService, RenewalsService] })
export class SupportModule {}

/** Para el worker: avisos de vencimiento e incidencias del monitoreo, sin controladores */
@Module({ providers: [SupportService, RenewalsService], exports: [SupportService, RenewalsService] })
export class SupportCoreModule {}
