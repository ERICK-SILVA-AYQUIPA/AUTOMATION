import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { DatabaseService } from '../database/database.service.js';
import { ProductsService, productInclude, withStock } from './products.service.js';
import { createProductSchema } from './catalog.schemas.js';
import { slugify } from '../auth/auth.service.js';
import type { TenantPrincipal } from '../common/context/principal.js';

/** Columnas de la plantilla (en español, en este orden) */
export const COLUMNS = ['sku', 'codigo_barras', 'nombre', 'descripcion', 'categoria', 'precio_venta', 'precio_compra', 'stock_minimo', 'estado', 'stock_inicial'] as const;
type Row = Partial<Record<(typeof COLUMNS)[number], string>>;

export interface ImportResult {
  dryRun: boolean;
  created: number;
  updated: number;
  errors: { row: number; message: string }[];
}

const MAX_ROWS = 5000;

/** Texto de una celda de Excel (texto enriquecido, hipervínculo, fórmula, fecha...) */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((r) => r.text).join('');
    if (o.text !== undefined) return cellText(o.text);
    if (o.result !== undefined) return cellText(o.result);
    return '';
  }
  return String(v as string | number | boolean);
}

@Injectable()
export class ImportExportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly products: ProductsService,
  ) {}

  async parse(buf: Buffer, filename: string): Promise<Row[]> {
    const lower = filename.toLowerCase();
    let rows: Record<string, unknown>[];
    if (lower.endsWith('.csv')) {
      const text = buf.toString('utf8').replace(/^﻿/, '');
      const r = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim().toLowerCase() });
      if (r.errors.length) throw new BadRequestException(`CSV inválido: ${r.errors[0]!.message} (fila ${(r.errors[0]!.row ?? 0) + 2})`);
      rows = r.data;
    } else if (lower.endsWith('.xlsx')) {
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
      } catch {
        throw new BadRequestException('El archivo Excel no es válido');
      }
      const ws = wb.worksheets[0];
      if (!ws) throw new BadRequestException('El Excel no tiene hojas');
      const header = (ws.getRow(1).values as unknown[]).slice(1).map((h) => cellText(h).trim().toLowerCase());
      rows = [];
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const vals = (row.values as unknown[]).slice(1);
        const obj: Record<string, unknown> = {};
        header.forEach((h, i) => {
          obj[h] = cellText(vals[i]);
        });
        if (Object.values(obj).some((v) => cellText(v).trim() !== '')) rows.push(obj);
      });
    } else {
      throw new BadRequestException('Formato no admitido: usa .csv o .xlsx');
    }
    if (rows.length > MAX_ROWS) throw new BadRequestException(`Máximo ${MAX_ROWS} filas por importación`);
    const missing = ['sku', 'nombre', 'precio_venta'].filter((c) => rows.length && !(c in rows[0]!));
    if (missing.length) throw new BadRequestException(`Faltan columnas obligatorias: ${missing.join(', ')}`);
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cellText(v).trim()])) as Row);
  }

  /**
   * Importa en UNA transacción: o entra todo o nada. Crea productos nuevos
   * (por SKU) y actualiza los existentes. stock_inicial solo aplica a nuevos;
   * el stock de existentes se modifica con movimientos de inventario.
   */
  async import(p: TenantPrincipal, rows: Row[], dryRun: boolean): Promise<ImportResult> {
    const result: ImportResult = { dryRun, created: 0, updated: 0, errors: [] };
    const run = async () =>
      this.db.tenant(
        p.tenantId,
        async (tx) => {
          const cats = new Map((await tx.category.findMany({ where: { tenantId: p.tenantId } })).map((c) => [c.name.toLowerCase(), c.id]));
          for (const [i, r] of rows.entries()) {
            const rowNum = i + 2;
            let categoryId: string | null = null;
            if (r.categoria) {
              categoryId = cats.get(r.categoria.toLowerCase()) ?? null;
              if (!categoryId) {
                const c = await tx.category.create({ data: { tenantId: p.tenantId, name: r.categoria, slug: slugify(r.categoria) } });
                cats.set(r.categoria.toLowerCase(), c.id);
                categoryId = c.id;
              }
            }
            const status = (r.estado || 'ACTIVE').toUpperCase().replace('ACTIVO', 'ACTIVE').replace('INACTIVO', 'INACTIVE');
            const parsed = createProductSchema.safeParse({
              sku: r.sku, barcode: r.codigo_barras || null, name: r.nombre, description: r.descripcion || null, categoryId,
              salePrice: r.precio_venta?.replace(',', '.'), costPrice: r.precio_compra ? r.precio_compra.replace(',', '.') : null,
              minStock: r.stock_minimo ? Number(r.stock_minimo) : 0, status,
              initialStock: r.stock_inicial ? Number(r.stock_inicial) : undefined,
            });
            if (!parsed.success) {
              result.errors.push({ row: rowNum, message: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
              continue;
            }
            const existing = await tx.product.findFirst({ where: { tenantId: p.tenantId, sku: parsed.data.sku } });
            try {
              if (existing) {
                const { initialStock: _i, variants: _v, ...upd } = parsed.data;
                await tx.product.update({ where: { id: existing.id }, data: upd });
                await tx.productHistory.create({ data: { tenantId: p.tenantId, productId: existing.id, userId: p.userId, action: 'imported_update', changes: { row: rowNum } } });
                result.updated++;
              } else {
                await this.products.createInTx(tx, p, parsed.data);
                result.created++;
              }
            } catch (e) {
              result.errors.push({ row: rowNum, message: (e as Error).message });
              throw new RowError();
            }
          }
          if (result.errors.length || dryRun) throw new Rollback();
        },
        { timeout: 120_000 },
      );
    try {
      await run();
    } catch (e) {
      if (!(e instanceof Rollback) && !(e instanceof RowError)) throw e;
    }
    if (result.errors.length) {
      // Nada se guardó: la transacción se revirtió
      return { ...result, created: 0, updated: 0 };
    }
    return result;
  }

  async export(p: TenantPrincipal, format: 'csv' | 'xlsx'): Promise<Buffer> {
    const products = await this.db.tenant(p.tenantId, (tx) =>
      tx.product.findMany({ where: { tenantId: p.tenantId, status: { not: 'ARCHIVED' } }, include: productInclude, orderBy: { name: 'asc' } }),
    );
    const rows = products.map(withStock).map((x) => ({
      sku: x.sku, codigo_barras: x.barcode ?? '', nombre: x.name, descripcion: x.description ?? '', categoria: x.category?.name ?? '',
      precio_venta: x.salePrice.toString(), precio_compra: x.costPrice?.toString() ?? '', stock_minimo: String(x.minStock),
      estado: x.status, stock_actual: String(x.stock), variantes: x.variants.map((v) => `${v.name} (${v.sku}): ${v.stock}`).join(' | '),
    }));
    if (format === 'csv') {
      return Buffer.from('﻿' + Papa.unparse(rows, { escapeFormulae: true, columns: [...COLUMNS.filter((c) => c !== 'stock_inicial'), 'stock_actual', 'variantes'] }), 'utf8');
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Productos');
    const cols = Object.keys(rows[0] ?? Object.fromEntries([...COLUMNS, 'stock_actual', 'variantes'].map((c) => [c, '']))) as string[];
    ws.columns = cols.map((c) => ({ header: c, key: c, width: c === 'descripcion' || c === 'variantes' ? 40 : 16 }));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async template(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Productos');
    ws.columns = COLUMNS.map((c) => ({ header: c, key: c, width: 16 }));
    ws.getRow(1).font = { bold: true };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}

class Rollback extends Error {}
class RowError extends Error {}
