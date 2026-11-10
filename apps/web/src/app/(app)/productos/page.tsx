'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Package, Plus, ScanBarcode, Search, Upload } from 'lucide-react';
import { api, ApiError, download } from '@/lib/api';
import { useAuth, useCurrency } from '@/lib/auth';
import { money, num, PRODUCT_STATUS } from '@/lib/format';
import type { Category, Paged, Product } from '@/lib/types';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Input, PageHeader, Pagination, Select, Skeleton, Table, Td, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';
import { BarcodeScanner } from '@/components/barcode-scanner';

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ dryRun: boolean; created: number; updated: number; errors: { row: number; message: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api<NonNullable<typeof result>>('/products/import', { method: 'POST', body: fd, query: { dryRun: dryRun ? 'true' : undefined } });
      setResult(r);
      if (!dryRun && !r.errors.length) {
        toast.success(`Importación lista: ${r.created} creados, ${r.updated} actualizados`);
        qc.invalidateQueries({ queryKey: ['products'] });
        close();
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setFile(null);
    setResult(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Importar productos"
      footer={
        <>
          <Button variant="secondary" onClick={() => run(true)} disabled={!file} loading={busy}>Validar</Button>
          <Button onClick={() => run(false)} disabled={!file || !result || !result.dryRun || result.errors.length > 0} loading={busy}>Importar</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted">
          Sube un archivo Excel (.xlsx) o CSV. Primero se valida sin guardar; si todas las filas son correctas puedes importar. Es todo o nada: si una fila falla, no se guarda ninguna.
          Las filas con un SKU existente actualizan ese producto.
        </p>
        <Button variant="secondary" size="sm" className="self-start" icon={<Download className="size-4" />} onClick={() => download('/products/import/template').catch(toast.error)}>
          Descargar plantilla
        </Button>
        <input
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setResult(null);
          }}
          className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-text"
          aria-label="Archivo a importar"
        />
        <ErrorBox error={error} />
        {result && (
          <div className="rounded-lg border border-border p-3">
            {result.errors.length ? (
              <>
                <p className="mb-2 font-medium text-danger">{result.errors.length} error(es). Corrige el archivo y vuelve a validar.</p>
                <ul className="max-h-48 list-disc overflow-y-auto pl-5 text-danger">
                  {result.errors.map((e, i) => <li key={i}>Fila {e.row}: {e.message}</li>)}
                </ul>
              </>
            ) : (
              <p className="text-success">Archivo válido: se crearán {result.created} y se actualizarán {result.updated} producto(s).</p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ProductsList() {
  const { can } = useAuth();
  const cur = useCurrency();
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState('');
  const params = useSearchParams();
  const [categoryId, setCategoryId] = useState(params.get('categoryId') ?? '');
  const [status, setStatus] = useState('');
  const [lowStock, setLowStock] = useState(params.get('lowStock') === 'true');
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const dq = useDebounced(q);

  // Cualquier cambio de filtro vuelve a la página 1
  const reset = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setPage(1);
  };

  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/categories') });
  const list = useQuery({
    queryKey: ['products', { dq, categoryId, status, lowStock, sort, page }],
    queryFn: () => api<Paged<Product>>('/products', { query: { q: dq, categoryId, status, lowStock: lowStock ? 'true' : undefined, sort, page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });

  const onScan = useCallback(
    async (code: string) => {
      setScanOpen(false);
      try {
        const p = await api<Product>(`/products/barcode/${encodeURIComponent(code)}`);
        router.push(`/productos/${p.id}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && can('products:write')) {
          toast.error(`No hay productos con el código ${code}. Puedes crearlo ahora.`);
          router.push(`/productos/nuevo?barcode=${encodeURIComponent(code)}`);
        } else toast.error(e);
      }
    },
    [router, toast, can],
  );

  return (
    <>
      <PageHeader
        title="Productos"
        description="Catálogo, precios y stock. El asistente de IA solo ofrece productos activos."
        actions={
          <>
            <Button variant="secondary" icon={<ScanBarcode className="size-4" />} onClick={() => setScanOpen(true)}>Escanear</Button>
            <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => download('/products/export', { format: 'xlsx' }).catch(toast.error)}>Excel</Button>
            <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => download('/products/export', { format: 'csv' }).catch(toast.error)}>CSV</Button>
            {can('products:write') && (
              <>
                <Button variant="secondary" icon={<Upload className="size-4" />} onClick={() => setImportOpen(true)}>Importar</Button>
                <Link href="/productos/nuevo"><Button icon={<Plus className="size-4" />}>Nuevo producto</Button></Link>
              </>
            )}
          </>
        }
      />
      <Card>
        <div className="flex flex-col gap-2 border-b border-border p-3 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input className="pl-9" placeholder="Buscar por nombre, SKU o código de barras" value={q} onChange={(e) => reset(setQ)(e.target.value)} aria-label="Buscar productos" />
          </div>
          <Select className="md:w-44" value={categoryId} onChange={(e) => reset(setCategoryId)(e.target.value)} aria-label="Categoría">
            <option value="">Todas las categorías</option>
            {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select className="md:w-36" value={status} onChange={(e) => reset(setStatus)(e.target.value)} aria-label="Estado">
            <option value="">Activos e inactivos</option>
            <option value="ACTIVE">Activos</option>
            <option value="INACTIVE">Inactivos</option>
            <option value="ARCHIVED">Archivados</option>
          </Select>
          <Select className="md:w-40" value={sort} onChange={(e) => reset(setSort)(e.target.value)} aria-label="Ordenar">
            <option value="name">Nombre A-Z</option>
            <option value="-createdAt">Más recientes</option>
            <option value="salePrice">Precio menor</option>
            <option value="-salePrice">Precio mayor</option>
          </Select>
          <label className="flex items-center gap-2 whitespace-nowrap text-sm">
            <input type="checkbox" checked={lowStock} onChange={(e) => reset(setLowStock)(e.target.checked)} className="size-4 accent-[var(--primary)]" /> Poco stock
          </label>
        </div>
        <ErrorBox error={list.error} />
        {list.isLoading ? (
          <div className="flex flex-col gap-2 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : !list.data?.items.length ? (
          <EmptyState
            icon={<Package className="size-5" />}
            title={dq || categoryId || status || lowStock ? 'Ningún producto coincide' : 'Aún no tienes productos'}
            description={dq || categoryId || status || lowStock ? 'Prueba con otros filtros.' : 'Crea tu primer producto o importa tu catálogo desde Excel.'}
            action={can('products:write') && !dq ? <Link href="/productos/nuevo"><Button icon={<Plus className="size-4" />}>Nuevo producto</Button></Link> : undefined}
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr><Th>Producto</Th><Th>Categoría</Th><Th className="text-right">Precio</Th><Th className="text-right">Stock</Th><Th>Estado</Th></tr>
              </thead>
              <tbody>
                {list.data.items.map((p) => (
                  <tr key={p.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => router.push(`/productos/${p.id}`)}>
                    <Td>
                      <div className="flex items-center gap-3">
                        {p.images[0] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.images[0].url} alt="" className="size-9 rounded-md object-cover" />
                        ) : (
                          <span className="flex size-9 items-center justify-center rounded-md bg-surface-2 text-muted"><Package className="size-4" /></span>
                        )}
                        <div className="min-w-0">
                          <Link href={`/productos/${p.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                          <p className="text-xs text-muted">{p.sku}{p.variants.length > 1 ? ` · ${p.variants.length} variantes` : ''}</p>
                        </div>
                      </div>
                    </Td>
                    <Td className="text-muted">{p.category?.name ?? '—'}</Td>
                    <Td className="text-right tabular-nums">{money(p.salePrice, cur)}</Td>
                    <Td className="text-right tabular-nums">
                      <span className={p.lowStock ? 'font-medium text-danger' : ''}>{num(p.stock)}</span>
                      {p.lowStock && <span className="ml-1 text-xs text-danger">(mín. {p.minStock})</span>}
                    </Td>
                    <Td><Badge tone={p.status === 'ACTIVE' ? 'success' : p.status === 'ARCHIVED' ? 'neutral' : 'warning'}>{PRODUCT_STATUS[p.status]}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      {scanOpen && <BarcodeScanner open onClose={() => setScanOpen(false)} onDetected={onScan} />}
    </>
  );
}

export default function ProductosPage() {
  return (
    <RequirePermission permission="products:read">
      <Suspense>
        <ProductsList />
      </Suspense>
    </RequirePermission>
  );
}
