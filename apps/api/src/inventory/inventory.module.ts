import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';
import { BranchesController, InventoryController } from './inventory.controller.js';

@Module({ controllers: [InventoryController, BranchesController], providers: [InventoryService], exports: [InventoryService] })
export class InventoryModule {}
