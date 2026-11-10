import { Module } from '@nestjs/common';
import { CategoriesController, ProductsController } from './catalog.controller.js';
import { ProductsService } from './products.service.js';
import { CategoriesService } from './categories.service.js';
import { ImportExportService } from './import-export.service.js';
import { InventoryModule } from '../inventory/inventory.module.js';

@Module({
  imports: [InventoryModule],
  controllers: [CategoriesController, ProductsController],
  providers: [ProductsService, CategoriesService, ImportExportService],
  exports: [ProductsService],
})
export class CatalogModule {}
