import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';

@Module({ imports: [InventoryModule], controllers: [ReservationsController], providers: [ReservationsService], exports: [ReservationsService] })
export class ReservationsModule {}
