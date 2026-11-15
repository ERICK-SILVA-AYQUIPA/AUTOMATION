'use client';

import { Copy } from 'lucide-react';
import { Button, Dialog, Input } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export const QUOTE_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Borrador', tone: 'neutral' },
  SENT: { label: 'Enviada', tone: 'info' },
  ACCEPTED: { label: 'Aceptada', tone: 'success' },
  REJECTED: { label: 'Rechazada', tone: 'danger' },
  EXPIRED: { label: 'Vencida', tone: 'warning' },
  CANCELLED: { label: 'Anulada', tone: 'neutral' },
};
export const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pendiente de pago', tone: 'warning' },
  PROOF_SUBMITTED: { label: 'Comprobante por validar', tone: 'info' },
  PAID: { label: 'Pagada', tone: 'success' },
  CANCELLED: { label: 'Anulada', tone: 'neutral' },
};
export const INSTALL_STATUS: Record<string, { label: string; tone: Tone }> = {
  AUTHORIZED: { label: 'Autorizada', tone: 'info' },
  IN_PROGRESS: { label: 'En curso', tone: 'warning' },
  DONE: { label: 'Terminada', tone: 'success' },
  CANCELLED: { label: 'Cancelada', tone: 'neutral' },
};
export const KIND: Record<string, string> = {
  PLAN: 'Plan', USERS: 'Usuarios', MODULE: 'Módulo', SETUP: 'Instalación', SERVER: 'Servidor', INTEGRATION: 'Integración', SERVICE: 'Servicio adicional', SUPPORT: 'Soporte', MAINTENANCE: 'Mantenimiento', OTHER: 'Otro',
};
export const BILLING: Record<string, string> = { ONE_TIME: 'Pago único', MONTHLY: 'Mensual' };
export const quoteNo = (n: number) => `COT-${String(n).padStart(5, '0')}`;
export const orderNo = (n: number) => `OP-${String(n).padStart(5, '0')}`;
export const installNo = (n: number) => `OI-${String(n).padStart(5, '0')}`;
export const entryNo = (n: number) => `AS-${String(n).padStart(5, '0')}`;

export interface Item { id: string; code: string; name: string; description: string | null; kind: string; billing: 'ONE_TIME' | 'MONTHLY'; unitPrice: string; currency: string; unit: string | null; planCode: string | null; module: string | null; isActive: boolean; sort: number }
export interface Line { itemId: string | null; kind: string; billing: 'ONE_TIME' | 'MONTHLY'; description: string; quantity: string; unitPrice: string; total?: string }
export interface Quote {
  id: string; number: number; status: string; currency: string; country: string | null; planCode: string | null; users: number | null; modules: string[]; deploymentMode: string | null;
  serverResources: string | null; initialSetup: string | null; integrations: string | null; support: string | null; maintenance: string | null; notes: string | null;
  initialPayment: 'ONE_TIME' | 'ONE_TIME_AND_FIRST_MONTH'; validUntil: string | null; terms: string | null;
  subtotalOneTime: string; subtotalMonthly: string; taxName: string | null; taxRate: string | null; pricesIncludeTax: boolean; taxOneTime: string; taxMonthly: string; totalOneTime: string; totalMonthly: string; initialAmount: string;
  sentAt: string | null; acceptedAt: string | null; acceptedName: string | null; acceptedDocument: string | null; acceptedIp: string | null; rejectedAt: string | null; rejectionReason: string | null; createdAt: string; updatedAt: string;
  lines: (Line & { id: string; position: number })[];
  lead: { id: string; number: number; name: string; company: string | null; email: string | null; phone: string | null; status: string };
  contractVersion: { id: string; version: number; title: string } | null;
  paymentOrders: { id: string; number: number; status: string; amount: string; currency: string; createdAt: string }[];
}

export interface PaymentMethodConfig { id: string; kind: string; name: string; instructions: string; countries: string[]; currencies: string[]; isActive: boolean; sort: number }

/** Enlace del cliente: se muestra una sola vez (la API guarda solo su huella) */
export function LinkDialog({ path, title, onClose }: { path: string | null; title: string; onClose: () => void }) {
  const toast = useToast();
  const url = path && typeof window !== 'undefined' ? `${window.location.origin}${path}` : '';
  return (
    <Dialog open={!!path} onClose={onClose} title={title} footer={<Button onClick={onClose}>Listo</Button>}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">Copia el enlace y envíaselo al cliente. Por seguridad no se vuelve a mostrar: si se pierde, genera uno nuevo (el anterior deja de funcionar).</p>
        <div className="flex gap-2">
          <Input readOnly value={url} aria-label="Enlace del cliente" onFocus={(e) => e.currentTarget.select()} />
          <Button
            variant="secondary"
            icon={<Copy className="size-4" />}
            onClick={() => {
              navigator.clipboard.writeText(url).then(() => toast.success('Enlace copiado'), () => toast.error('No se pudo copiar: selecciona el texto y cópialo'));
            }}
          >Copiar</Button>
        </div>
      </div>
    </Dialog>
  );
}
