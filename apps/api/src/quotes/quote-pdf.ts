import PDFDocument from 'pdfkit';

export const quoteNo = (n: number) => `COT-${String(n).padStart(5, '0')}`;
export const orderNo = (n: number) => `OP-${String(n).padStart(5, '0')}`;
export const installNo = (n: number) => `OI-${String(n).padStart(5, '0')}`;

const nf = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amount = (currency: string, v: string | { toString(): string }) => `${currency} ${nf.format(Number(v.toString()))}`;
const day = (d: Date | string) => new Intl.DateTimeFormat('es-PE', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(d));

const MODE: Record<string, string> = { SAAS: 'En nuestra plataforma', DEDICATED: 'Instancia dedicada', CUSTOM: 'Solución a medida' };
const STATUS: Record<string, string> = { DRAFT: 'Borrador', SENT: 'Enviada', ACCEPTED: 'Aceptada', REJECTED: 'Rechazada', EXPIRED: 'Vencida', CANCELLED: 'Anulada' };

export interface QuotePdfData {
  number: number;
  status: string;
  currency: string;
  sentAt: Date | null;
  validUntil: Date | null;
  issuer: { legalName: string | null; taxId: string | null; address: string | null; email: string | null; whatsapp: string | null };
  client: { name: string; company: string | null; email: string | null; phone: string | null; country: string | null };
  planName: string | null;
  users: number | null;
  modules: string[];
  deploymentMode: string | null;
  serverResources: string | null;
  initialSetup: string | null;
  integrations: string | null;
  support: string | null;
  maintenance: string | null;
  notes: string | null;
  lines: { description: string; billing: 'ONE_TIME' | 'MONTHLY'; quantity: string; unitPrice: string; total: string }[];
  taxName: string | null;
  taxRate: string | null;
  pricesIncludeTax: boolean;
  subtotalOneTime: string; taxOneTime: string; totalOneTime: string;
  subtotalMonthly: string; taxMonthly: string; totalMonthly: string;
  initialPayment: 'ONE_TIME' | 'ONE_TIME_AND_FIRST_MONTH';
  initialAmount: string;
  terms: string | null;
  contract: { version: number; title: string } | null;
  accepted: { at: Date; name: string; document: string | null } | null;
}

/**
 * PDF de la cotización con fuentes estándar (sin archivos externos). Los datos
 * vienen de la cotización guardada: el documento no calcula ni inventa nada.
 */
export function renderQuotePdf(q: QuotePdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: `Cotización ${quoteNo(q.number)}`, Author: q.issuer.legalName ?? 'AI Sales Assistant' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const W = doc.page.width - 100;
  const muted = '#555555';
  const line = () => doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor('#dddddd').lineWidth(1).stroke().moveDown(0.6);
  const section = (title: string) => {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(title).moveDown(0.3);
  };
  const pair = (k: string, v: string | null | undefined) => {
    if (!v) return;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111111').text(`${k}: `, { continued: true }).font('Helvetica').fillColor('#222222').text(v);
  };

  // Encabezado: emisor y número
  const top = doc.y;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111111').text(q.issuer.legalName ?? 'AI Sales Assistant', 50, top, { width: W * 0.6 });
  doc.font('Helvetica').fontSize(9).fillColor(muted);
  for (const v of [q.issuer.taxId && `RUC / ID fiscal: ${q.issuer.taxId}`, q.issuer.address, q.issuer.email, q.issuer.whatsapp]) if (v) doc.text(v, { width: W * 0.6 });
  const leftEnd = doc.y;
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111').text('COTIZACIÓN', 50 + W * 0.6, top, { width: W * 0.4, align: 'right' });
  doc.font('Helvetica').fontSize(10).text(quoteNo(q.number), { width: W * 0.4, align: 'right' });
  doc.fontSize(9).fillColor(muted);
  if (q.sentAt) doc.text(`Emitida: ${day(q.sentAt)}`, { width: W * 0.4, align: 'right' });
  if (q.validUntil) doc.text(`Válida hasta: ${day(q.validUntil)}`, { width: W * 0.4, align: 'right' });
  doc.text(`Estado: ${STATUS[q.status] ?? q.status}`, { width: W * 0.4, align: 'right' });
  doc.x = 50;
  doc.y = Math.max(leftEnd, doc.y) + 12;
  line();

  section('Cliente');
  pair('Nombre', q.client.name);
  pair('Empresa', q.client.company);
  pair('Correo', q.client.email);
  pair('Teléfono', q.client.phone);
  pair('País', q.client.country);

  section('Solución propuesta');
  pair('Plan', q.planName);
  pair('Usuarios', q.users ? String(q.users) : null);
  pair('Módulos', q.modules.join(', ') || null);
  pair('Modalidad de instalación', q.deploymentMode ? (MODE[q.deploymentMode] ?? q.deploymentMode) : null);
  pair('Recursos de servidor', q.serverResources);
  pair('Configuración inicial', q.initialSetup);
  pair('Integraciones', q.integrations);
  pair('Soporte', q.support);
  pair('Mantenimiento', q.maintenance);
  pair('Observaciones', q.notes);

  section('Detalle');
  const cols = [W * 0.46, W * 0.12, W * 0.1, W * 0.16, W * 0.16];
  const xs = cols.reduce<number[]>((a, w, i) => [...a, i === 0 ? 50 : a[i - 1]! + cols[i - 1]!], []);
  const row = (vals: string[], bold = false) => {
    if (doc.y > doc.page.height - 90) doc.addPage();
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#111111');
    let maxY = y;
    vals.forEach((v, i) => {
      doc.text(v, xs[i]!, y, { width: cols[i]! - 6, align: i === 0 ? 'left' : 'right' });
      maxY = Math.max(maxY, doc.y);
    });
    doc.x = 50;
    doc.y = maxY + 4;
  };
  row(['Descripción', 'Cobro', 'Cant.', 'P. unitario', 'Total'], true);
  line();
  for (const l of q.lines) row([l.description, l.billing === 'ONE_TIME' ? 'Único' : 'Mensual', String(Number(l.quantity)), amount(q.currency, l.unitPrice), amount(q.currency, l.total)]);
  line();

  const tax = q.taxName ? `${q.taxName} ${Number(q.taxRate)} %${q.pricesIncludeTax ? ' (incluido)' : ''}` : null;
  const totals = (label: string, sub: string, t: string, tot: string) => {
    if (Number(tot) === 0) return;
    row([`${label}: subtotal`, '', '', '', amount(q.currency, sub)]);
    if (tax) row([`${label}: ${tax}`, '', '', '', amount(q.currency, t)]);
    row([`${label}: total`, '', '', '', amount(q.currency, tot)], true);
  };
  totals('Pago único (instalación y servicios)', q.subtotalOneTime, q.taxOneTime, q.totalOneTime);
  totals('Mensualidad', q.subtotalMonthly, q.taxMonthly, q.totalMonthly);
  if (!tax) doc.font('Helvetica').fontSize(8.5).fillColor(muted).text('Importes sin impuestos aplicados.').moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111').text(`Pago inicial para activar el servicio: ${amount(q.currency, q.initialAmount)} (${q.initialPayment === 'ONE_TIME' ? 'pago único' : 'pago único y primera mensualidad'})`);

  section('Condiciones');
  doc.font('Helvetica').fontSize(9).fillColor('#222222').text(q.terms ?? '—', { width: W });
  if (q.contract) doc.moveDown(0.3).text(`Al aceptar esta cotización se acepta el contrato «${q.contract.title}», versión ${q.contract.version}.`, { width: W });
  doc.moveDown(0.3).text('La instalación se inicia después de validar el pago en nuestra cuenta. Un comprobante por sí solo no confirma el pago.', { width: W });

  if (q.accepted) {
    section('Aceptación');
    pair('Aceptada por', q.accepted.name);
    pair('Documento', q.accepted.document);
    pair('Fecha', new Intl.DateTimeFormat('es-PE', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Lima' }).format(q.accepted.at));
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(muted).text(`${quoteNo(q.number)} · página ${i + 1} de ${range.count}`, 50, doc.page.height - 40, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}
