'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import { money, num } from '@/lib/format';
import type { Paged, Product, Variant } from '@/lib/types';
import { Input, Spinner } from '@/components/ui';

export interface PickedVariant { variant: Variant; product: Product; label: string }

/** Buscador de producto → variante (para movimientos de inventario y pedidos). Solo productos activos. */
/** `stockedOnly`: solo productos que controlan stock (movimientos de inventario) */
export function VariantPicker({ onPick, currency, autoFocus, id, stockedOnly }: { onPick: (p: PickedVariant) => void; currency: string; autoFocus?: boolean; id?: string; stockedOnly?: boolean }) {
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const res = useQuery({
    queryKey: ['variant-picker', dq, !!stockedOnly],
    queryFn: () => api<Paged<Product>>('/products', { query: { q: dq, status: 'ACTIVE', pageSize: 8, trackStock: stockedOnly ? 'true' : undefined } }),
    enabled: dq.length > 0,
  });
  const options = res.data?.items.flatMap((p) => p.variants.filter((v) => v.isActive).map((v) => ({ p, v }))) ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input id={id} autoFocus={autoFocus} className="pl-9" placeholder="Buscar producto por nombre, SKU o código" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar producto" />
      </div>
      {dq && (
        <div className="max-h-60 overflow-y-auto rounded-lg border border-border">
          {res.isLoading ? (
            <div className="flex justify-center p-4"><Spinner /></div>
          ) : !options.length ? (
            <p className="p-3 text-sm text-muted">Sin resultados entre los productos activos.</p>
          ) : (
            options.map(({ p, v }) => {
              const label = p.variants.length > 1 ? `${p.name} · ${v.name}` : p.name;
              return (
                <button
                  type="button"
                  key={v.id}
                  onClick={() => {
                    onPick({ variant: v, product: p, label });
                    setQ('');
                  }}
                  className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left text-sm last:border-0 hover:bg-surface-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{label}</span>
                    <span className="text-xs text-muted">{v.sku}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs">
                    <span className="block">{money(v.effectivePrice, currency)}</span>
                    {p.trackStock === false ? <span className="text-muted">Sin control de stock</span> : <span className={v.stock <= 0 ? 'text-danger' : 'text-muted'}>Stock: {num(v.stock)}</span>}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
