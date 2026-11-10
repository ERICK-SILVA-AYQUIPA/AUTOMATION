'use client';

import { useState } from 'react';
import { Download, FileSpreadsheet } from 'lucide-react';
import { download } from '@/lib/api';
import { Button, Card, Field, Input, PageHeader } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

const iso = (d: Date) => d.toISOString().slice(0, 10);

function Reports() {
  const toast = useToast();
  const today = new Date();
  const [from, setFrom] = useState(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(iso(today));
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (k: string, fn: () => Promise<void>) => {
    setBusy(k);
    try {
      await fn();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const reports = [
    { k: 'sales', title: 'Ventas por día', desc: 'Pedidos confirmados (sin anulados), unidades y total por día, en la zona horaria de tu empresa.', fn: () => download('/reports/sales.csv', { from, to }) },
    { k: 'orders', title: 'Detalle de pedidos', desc: 'Cada pedido del rango con cliente, productos, estado y total.', fn: () => download('/orders/export', { from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59.999`).toISOString() }) },
    { k: 'products', title: 'Catálogo y stock actual', desc: 'Todos los productos y variantes con precio y stock (Excel). No depende del rango.', fn: () => download('/products/export', { format: 'xlsx' }) },
  ];
  return (
    <>
      <PageHeader title="Reportes" description="Descargas en CSV o Excel generadas con los datos reales de tu empresa." />
      <Card className="mb-6 flex flex-wrap items-end gap-4 p-4">
        <Field label="Desde"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Hasta"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        <p className="text-xs text-muted">Rango máximo: un año.</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        {reports.map((r) => (
          <Card key={r.k} className="flex flex-col gap-3 p-4">
            <FileSpreadsheet className="size-5 text-muted" />
            <div className="flex-1">
              <h2 className="font-medium">{r.title}</h2>
              <p className="mt-1 text-sm text-muted">{r.desc}</p>
            </div>
            <Button variant="secondary" icon={<Download className="size-4" />} loading={busy === r.k} onClick={() => run(r.k, r.fn)}>Descargar</Button>
          </Card>
        ))}
      </div>
    </>
  );
}

export default function ReportesPage() {
  return <RequirePermission permission="reports:read"><Reports /></RequirePermission>;
}
