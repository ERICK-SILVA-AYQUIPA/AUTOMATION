import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Principal } from '../common/context/principal.js';
import { CurrentUser, Public, RequirePermission } from '../common/decorators/auth.decorators.js';
import { PaymentsService, allowedMethodsSchema, methodSchema, proofSchema, reasonSchema, validateSchema } from './payments.service.js';
import { QuotesService, acceptSchema, contractSchema, createQuoteSchema, itemSchema, quoteSchema, quoteSettingsSchema, rejectSchema, type ItemInput, type QuoteInput } from './quotes.service.js';

const id = { schema: z.uuid() };
const quoteFilter = z.object({ status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED']).optional(), leadId: z.uuid().optional() });
const orderFilter = z.object({ status: z.enum(['PENDING', 'PROOF_SUBMITTED', 'PAID', 'CANCELLED']).optional(), leadId: z.uuid().optional() });
const ledgerFilter = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });
const installFilter = z.object({ status: z.enum(['AUTHORIZED', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional() });
const installStatus = z.object({ status: z.enum(['IN_PROGRESS', 'DONE', 'CANCELLED']), note: z.string().trim().max(1000).nullable().optional() });
const cancelQuote = z.object({ reason: z.string().trim().max(1000).nullable().optional() });

const pdf = (res: Response, f: { name: string; buffer: Buffer }) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.send(f.buffer);
};

/** Catálogo, cotizaciones, pagos, contabilidad e instalaciones de nuestro negocio (ADR 049) */
@RequirePermission('platform:manage')
@Controller('platform/commerce')
export class CommerceController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('items')
  items() {
    return this.quotes.items();
  }
  @Post('items')
  createItem(@CurrentUser() p: Principal, @Body({ schema: itemSchema }) b: ItemInput) {
    return this.quotes.createItem(p.userId, b);
  }
  @Put('items/:id')
  updateItem(@CurrentUser() p: Principal, @Param('id', id) itemId: string, @Body({ schema: itemSchema }) b: ItemInput) {
    return this.quotes.updateItem(p.userId, itemId, b);
  }

  @Get('contracts')
  contracts() {
    return this.quotes.contracts();
  }
  @Post('contracts')
  createContract(@CurrentUser() p: Principal, @Body({ schema: contractSchema }) b: z.infer<typeof contractSchema>) {
    return this.quotes.createContract(p.userId, b);
  }

  @Get('settings')
  settings() {
    return this.quotes.settings();
  }
  @Put('settings')
  updateSettings(@CurrentUser() p: Principal, @Body({ schema: quoteSettingsSchema }) b: z.infer<typeof quoteSettingsSchema>) {
    return this.quotes.updateSettings(p.userId, b);
  }

  @Get('quotes')
  list(@Query({ schema: quoteFilter }) q: z.infer<typeof quoteFilter>) {
    return this.quotes.list(q);
  }
  @Post('quotes')
  create(@CurrentUser() p: Principal, @Body({ schema: createQuoteSchema }) b: z.infer<typeof createQuoteSchema>) {
    return this.quotes.create(p.userId, b);
  }
  @Get('quotes/:id')
  get(@Param('id', id) quoteId: string) {
    return this.quotes.get(quoteId);
  }
  @Put('quotes/:id')
  update(@CurrentUser() p: Principal, @Param('id', id) quoteId: string, @Body({ schema: quoteSchema }) b: QuoteInput) {
    return this.quotes.update(p.userId, quoteId, b);
  }
  @Delete('quotes/:id')
  @HttpCode(204)
  remove(@CurrentUser() p: Principal, @Param('id', id) quoteId: string) {
    return this.quotes.remove(p.userId, quoteId);
  }
  @Post('quotes/:id/send')
  @HttpCode(200)
  send(@CurrentUser() p: Principal, @Param('id', id) quoteId: string) {
    return this.quotes.send(p.userId, quoteId);
  }
  @Post('quotes/:id/link')
  @HttpCode(200)
  relink(@CurrentUser() p: Principal, @Param('id', id) quoteId: string) {
    return this.quotes.relink(p.userId, quoteId);
  }
  @Post('quotes/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() p: Principal, @Param('id', id) quoteId: string, @Body({ schema: cancelQuote }) b: z.infer<typeof cancelQuote>) {
    return this.quotes.cancel(p.userId, quoteId, b.reason ?? null);
  }
  @Get('quotes/:id/pdf')
  async pdf(@Param('id', id) quoteId: string, @Res() res: Response) {
    pdf(res, await this.quotes.pdf(quoteId));
  }

  @Get('payment-methods')
  methods() {
    return this.payments.methods();
  }
  @Post('payment-methods')
  createMethod(@CurrentUser() p: Principal, @Body({ schema: methodSchema }) b: z.infer<typeof methodSchema>) {
    return this.payments.createMethod(p.userId, b);
  }
  @Put('payment-methods/:id')
  updateMethod(@CurrentUser() p: Principal, @Param('id', id) methodId: string, @Body({ schema: methodSchema }) b: z.infer<typeof methodSchema>) {
    return this.payments.updateMethod(p.userId, methodId, b);
  }

  @Get('payments')
  orders(@Query({ schema: orderFilter }) q: z.infer<typeof orderFilter>) {
    return this.payments.list(q);
  }
  @Get('payments/:id')
  order(@Param('id', id) orderId: string) {
    return this.payments.get(orderId);
  }
  @Post('payments/:id/validate')
  @HttpCode(200)
  validate(@CurrentUser() p: Principal, @Param('id', id) orderId: string, @Body({ schema: validateSchema }) b: z.infer<typeof validateSchema>) {
    return this.payments.validate(p.userId, orderId, b);
  }
  @Post('payments/:id/reject-proof')
  @HttpCode(200)
  rejectProof(@CurrentUser() p: Principal, @Param('id', id) orderId: string, @Body({ schema: reasonSchema }) b: z.infer<typeof reasonSchema>) {
    return this.payments.rejectProof(p.userId, orderId, b.reason);
  }
  @Post('payments/:id/cancel')
  @HttpCode(200)
  cancelOrder(@CurrentUser() p: Principal, @Param('id', id) orderId: string, @Body({ schema: reasonSchema }) b: z.infer<typeof reasonSchema>) {
    return this.payments.cancel(p.userId, orderId, b.reason);
  }
  @Post('payments/:id/link')
  @HttpCode(200)
  orderLink(@CurrentUser() p: Principal, @Param('id', id) orderId: string) {
    return this.payments.relink(p.userId, orderId);
  }
  @Put('payments/:id/methods')
  setMethods(@CurrentUser() p: Principal, @Param('id', id) orderId: string, @Body({ schema: allowedMethodsSchema }) b: z.infer<typeof allowedMethodsSchema>) {
    return this.payments.setAllowedMethods(p.userId, orderId, b.methodIds);
  }

  @Get('accounting')
  ledger(@Query({ schema: ledgerFilter }) q: z.infer<typeof ledgerFilter>) {
    return this.payments.ledger(q);
  }
  @Get('accounting/export')
  async ledgerCsv(@Query({ schema: ledgerFilter }) q: z.infer<typeof ledgerFilter>, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ingresos-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await this.payments.ledgerCsv(q));
  }

  @Get('installations')
  installations(@Query({ schema: installFilter }) q: z.infer<typeof installFilter>) {
    return this.payments.installations(q);
  }
  @Post('installations/:id/status')
  @HttpCode(200)
  installationStatus(@CurrentUser() p: Principal, @Param('id', id) installId: string, @Body({ schema: installStatus }) b: z.infer<typeof installStatus>) {
    return this.payments.setInstallationStatus(p.userId, installId, b.status, b.note ?? null);
  }
}

const token = z.string().min(20).max(100);

/** Enlaces del cliente: ver, descargar, aceptar o rechazar la propuesta; ver la orden e informar el pago */
@Public()
@Controller('public')
export class PublicCommerceController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('quotes/:id')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  quote(@Param('id', id) quoteId: string, @Query('t', { schema: token }) t: string) {
    return this.quotes.publicView(quoteId, t);
  }
  @Get('quotes/:id/pdf')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async quotePdf(@Param('id', id) quoteId: string, @Query('t', { schema: token }) t: string, @Res() res: Response) {
    pdf(res, await this.quotes.publicPdf(quoteId, t));
  }
  @Post('quotes/:id/accept')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  accept(@Req() req: Request, @Param('id', id) quoteId: string, @Body({ schema: acceptSchema.extend({ token }) }) b: z.infer<typeof acceptSchema> & { token: string }) {
    const { token: t, ...input } = b;
    return this.quotes.accept(quoteId, t, input, { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });
  }
  @Post('quotes/:id/reject')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  reject(@Param('id', id) quoteId: string, @Body({ schema: rejectSchema.extend({ token }) }) b: z.infer<typeof rejectSchema> & { token: string }) {
    return this.quotes.reject(quoteId, b.token, b.reason ?? null);
  }

  @Get('payments/:id')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  order(@Param('id', id) orderId: string, @Query('t', { schema: token }) t: string) {
    return this.payments.publicView(orderId, t);
  }
  @Post('payments/:id/proof')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  proof(@Param('id', id) orderId: string, @Body({ schema: proofSchema.extend({ token }) }) b: z.infer<typeof proofSchema> & { token: string }) {
    const { token: t, ...input } = b;
    return this.payments.submitProof(orderId, t, input);
  }
}
