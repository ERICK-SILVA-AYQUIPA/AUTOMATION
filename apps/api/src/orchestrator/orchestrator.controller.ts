import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import type { Principal } from '../common/context/principal.js';
import { CurrentUser, Public, RequirePermission } from '../common/decorators/auth.decorators.js';
import { OrchestratorService, cancelSchema, reportSchema, runSchema } from './orchestrator.service.js';
import { FLOW, STOPPED } from './steps.js';

const id = { schema: z.uuid() };
const filter = z.object({ status: z.enum(['DELIVERED', 'CANCELLED', ...FLOW, ...STOPPED]).optional() });
const bootstrapBody = z.object({ token: z.string().min(20).max(100) });

/** Instalaciones administradas (ADR 051): solo el equipo de la plataforma */
@RequirePermission('platform:manage')
@Controller('platform/provisioning')
export class OrchestratorController {
  constructor(private readonly o: OrchestratorService) {}

  @Get('options')
  options() {
    return this.o.options();
  }
  @Get('runs')
  list(@Query({ schema: filter }) q: z.infer<typeof filter>) {
    return this.o.list(q.status);
  }
  @Post('runs')
  create(@CurrentUser() p: Principal, @Body({ schema: runSchema }) b: z.infer<typeof runSchema>) {
    return this.o.create(p.userId, b);
  }
  @Get('runs/:id')
  get(@Param('id', id) rid: string) {
    return this.o.get(rid);
  }
  @Post('runs/:id/retry')
  @HttpCode(200)
  retry(@CurrentUser() p: Principal, @Param('id', id) rid: string) {
    return this.o.retry(p.userId, rid);
  }
  @Post('runs/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() p: Principal, @Param('id', id) rid: string, @Body({ schema: cancelSchema }) b: z.infer<typeof cancelSchema>) {
    return this.o.cancel(p.userId, rid, b);
  }
}

/** Canal del servidor nuevo: arranque de un solo uso y, después, token del agente */
@Public()
@Controller('public/provisioning')
export class ProvisioningAgentController {
  constructor(private readonly o: OrchestratorService) {}

  @Post(':id/bootstrap')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  bootstrap(@Param('id', id) rid: string, @Body({ schema: bootstrapBody }) b: z.infer<typeof bootstrapBody>) {
    return this.o.bootstrap(rid, b.token);
  }
  @Post(':id/report')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  report(@Param('id', id) rid: string, @Headers('authorization') auth: string | undefined, @Body({ schema: reportSchema }) b: z.infer<typeof reportSchema>) {
    return this.o.report(rid, auth, b);
  }
  @Get(':id/package')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async package(@Param('id', id) rid: string, @Headers('authorization') auth: string | undefined, @Res() res: Response) {
    const p = await this.o.package(rid, auth);
    res.set({ 'Content-Type': 'application/zip', 'Content-Length': String(p.buffer.length), 'X-Package-Sha256': p.sha256, 'Content-Disposition': `attachment; filename="${p.filename}"`, 'Cache-Control': 'no-store' });
    res.end(p.buffer);
  }
  @Get(':id/images')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async images(@Param('id', id) rid: string, @Headers('authorization') auth: string | undefined, @Res() res: Response) {
    const img = await this.o.images(rid, auth);
    res.set({ 'Content-Type': 'application/gzip', 'Content-Length': String(img.bytes), 'X-Images-Sha256': img.sha256, 'Cache-Control': 'no-store' });
    img.stream.pipe(res);
  }
}
