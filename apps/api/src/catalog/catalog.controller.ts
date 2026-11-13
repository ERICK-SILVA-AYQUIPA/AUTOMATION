import { RequireModule } from '../common/decorators/module.decorator.js';
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { StorageService, MAX_IMAGE_BYTES } from '../storage/storage.service.js';
import { ProductsService } from './products.service.js';
import { CategoriesService } from './categories.service.js';
import { ImportExportService } from './import-export.service.js';
import {
  categorySchema, createProductSchema, listProductsSchema, updateCategorySchema, updateProductSchema, updateVariantSchema, variantSchema,
  type CreateProductInput, type ListProductsQuery, type UpdateProductInput,
} from './catalog.schemas.js';

const uuid = { schema: z.uuid() };

@RequireModule('catalog')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly cats: CategoriesService) {}

  @RequirePermission('products:read')
  @Get()
  list(@TenantUser() p: TenantPrincipal) {
    return this.cats.list(p);
  }

  @RequirePermission('products:write')
  @Post()
  create(@TenantUser() p: TenantPrincipal, @Body({ schema: categorySchema }) b: z.infer<typeof categorySchema>) {
    return this.cats.create(p, b);
  }

  @RequirePermission('products:write')
  @Patch(':id')
  update(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @Body({ schema: updateCategorySchema }) b: z.infer<typeof updateCategorySchema>) {
    return this.cats.update(p, id, b);
  }

  @RequirePermission('products:write')
  @HttpCode(204)
  @Delete(':id')
  async remove(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    await this.cats.remove(p, id);
  }
}

@RequireModule('catalog')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly io: ImportExportService,
    private readonly storage: StorageService,
    private readonly db: DatabaseService,
  ) {}

  @RequirePermission('products:read')
  @Get()
  list(@TenantUser() p: TenantPrincipal, @Query({ schema: listProductsSchema }) q: ListProductsQuery) {
    return this.products.list(p, q);
  }

  @RequirePermission('products:read')
  @Get('export')
  async export(@TenantUser() p: TenantPrincipal, @Query('format', { schema: z.enum(['csv', 'xlsx']).default('xlsx') }) format: 'csv' | 'xlsx', @Res() res: Response) {
    const buf = await this.io.export(p, format);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="productos-${date}.${format}"`);
    res.send(buf);
  }

  @RequirePermission('products:read')
  @Get('import/template')
  async template(@Res() res: Response) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-productos.xlsx"');
    res.send(await this.io.template());
  }

  /** ?dryRun=true valida sin guardar. La importación es todo-o-nada. */
  @RequirePermission('products:write')
  @Post('import')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async import(@TenantUser() p: TenantPrincipal, @UploadedFile() file: Express.Multer.File | undefined, @Query('dryRun') dryRun?: string) {
    if (!file) throw new BadRequestException('Adjunta un archivo en el campo "file"');
    const rows = await this.io.parse(file.buffer, file.originalname);
    return this.io.import(p, rows, dryRun === 'true');
  }

  @RequirePermission('products:read')
  @Get('barcode/:code')
  byBarcode(@TenantUser() p: TenantPrincipal, @Param('code', { schema: z.string().regex(/^[0-9A-Za-z-]{4,64}$/) }) code: string) {
    return this.products.byBarcode(p, code);
  }

  @RequirePermission('products:read')
  @Get(':id')
  get(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    return this.products.get(p, id);
  }

  @RequirePermission('products:read')
  @Get(':id/history')
  history(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    return this.products.history(p, id);
  }

  @RequirePermission('products:write')
  @Post()
  create(@TenantUser() p: TenantPrincipal, @Body({ schema: createProductSchema }) b: CreateProductInput) {
    return this.products.create(p, b);
  }

  @RequirePermission('products:write')
  @Patch(':id')
  update(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @Body({ schema: updateProductSchema }) b: UpdateProductInput) {
    return this.products.update(p, id, b);
  }

  /** Archiva (no borra): conserva historial de ventas e inventario. */
  @RequirePermission('products:write')
  @Delete(':id')
  archive(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    return this.products.archive(p, id);
  }

  @RequirePermission('products:write')
  @Post(':id/variants')
  addVariant(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @Body({ schema: variantSchema }) b: z.infer<typeof variantSchema>) {
    return this.products.addVariant(p, id, b);
  }

  @RequirePermission('products:write')
  @Patch(':id/variants/:variantId')
  updateVariant(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @Param('variantId', uuid) vid: string, @Body({ schema: updateVariantSchema }) b: z.infer<typeof updateVariantSchema>) {
    return this.products.updateVariant(p, id, vid, b);
  }

  @RequirePermission('products:write')
  @Post(':id/images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }))
  async addImage(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('Adjunta una imagen en el campo "file"');
    const exists = await this.db.tenant(p.tenantId, (tx) => tx.product.count({ where: { id, tenantId: p.tenantId } }));
    if (!exists) throw new NotFoundException('Producto no encontrado');
    const saved = await this.storage.saveImage(p.tenantId, file.buffer);
    return this.db.tenant(p.tenantId, async (tx) => {
      const position = await tx.productImage.count({ where: { productId: id } });
      const img = await tx.productImage.create({ data: { tenantId: p.tenantId, productId: id, storageKey: saved.key, url: saved.url, position } });
      await tx.productHistory.create({ data: { tenantId: p.tenantId, productId: id, userId: p.userId, action: 'image_added', changes: { imageId: img.id } } });
      return img;
    });
  }

  @RequirePermission('products:write')
  @HttpCode(204)
  @Delete(':id/images/:imageId')
  async removeImage(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @Param('imageId', uuid) imageId: string) {
    const img = await this.db.tenant(p.tenantId, async (tx) => {
      const i = await tx.productImage.findFirst({ where: { id: imageId, productId: id, tenantId: p.tenantId } });
      if (!i) throw new NotFoundException('Imagen no encontrada');
      await tx.productImage.delete({ where: { id: imageId } });
      await tx.productHistory.create({ data: { tenantId: p.tenantId, productId: id, userId: p.userId, action: 'image_removed', changes: { imageId } } });
      return i;
    });
    await this.storage.remove(img.storageKey);
  }
}
