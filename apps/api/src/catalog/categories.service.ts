import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { slugify } from '../auth/auth.service.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import type { z } from 'zod';
import type { categorySchema, updateCategorySchema } from './catalog.schemas.js';

@Injectable()
export class CategoriesService {
  constructor(private readonly db: DatabaseService) {}

  list(p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const cats = await tx.category.findMany({ where: { tenantId: p.tenantId }, orderBy: { name: 'asc' }, include: { _count: { select: { products: { where: { status: { not: 'ARCHIVED' } } } } } } });
      return cats.map(({ _count, ...c }) => ({ ...c, productCount: _count.products }));
    });
  }

  create(p: TenantPrincipal, input: z.infer<typeof categorySchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      if (input.parentId && !(await tx.category.count({ where: { id: input.parentId, tenantId: p.tenantId } }))) {
        throw new BadRequestException('La categoría padre no existe');
      }
      return tx.category.create({ data: { ...input, tenantId: p.tenantId, slug: slugify(input.name) } });
    });
  }

  update(p: TenantPrincipal, id: string, input: z.infer<typeof updateCategorySchema>) {
    if (input.parentId === id) throw new BadRequestException('Una categoría no puede ser su propio padre');
    return this.db.tenant(p.tenantId, async (tx) => {
      const c = await tx.category.findFirst({ where: { id, tenantId: p.tenantId } });
      if (!c) throw new NotFoundException('Categoría no encontrada');
      return tx.category.update({ where: { id }, data: { ...input, ...(input.name ? { slug: slugify(input.name) } : {}) } });
    });
  }

  /** Borra la categoría; sus productos quedan "sin categoría" (no se borran). */
  remove(p: TenantPrincipal, id: string) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const c = await tx.category.findFirst({ where: { id, tenantId: p.tenantId } });
      if (!c) throw new NotFoundException('Categoría no encontrada');
      await tx.category.delete({ where: { id } });
    });
  }
}
