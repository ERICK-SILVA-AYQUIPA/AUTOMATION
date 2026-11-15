import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '../common/context/principal.js';
import { CurrentUser, RequirePermission } from '../common/decorators/auth.decorators.js';
import { InfraService, approveSchema, decisionSchema, deleteSchema, limitsSchema, powerSchema, providerSchema, requestSchema, sshKeySchema, tokenSchema } from './infra.service.js';

const id = { schema: z.uuid() };
const requestFilter = z.object({ status: z.enum(['PENDING_APPROVAL', 'REJECTED', 'CANCELLED', 'CREATING', 'CREATED', 'FAILED']).optional() });
const serverFilter = z.object({ deleted: z.enum(['true', 'false']).optional() });
const importBody = z.object({ externalId: z.string().regex(/^\d{1,20}$/) });
const activeBody = z.object({ isActive: z.boolean() });
const disabledBody = z.object({ disabled: z.boolean() });

/** Proveedores de infraestructura, claves SSH, solicitudes y servidores (ADR 050) */
@RequirePermission('platform:manage')
@Controller('platform/infra')
export class InfraController {
  constructor(private readonly infra: InfraService) {}

  @Get('kinds')
  kinds() {
    return this.infra.kinds();
  }

  @Get('providers')
  providers() {
    return this.infra.providers();
  }
  @Post('providers')
  create(@CurrentUser() p: Principal, @Body({ schema: providerSchema }) b: z.infer<typeof providerSchema>) {
    return this.infra.createProvider(p.userId, b);
  }
  @Get('providers/:id')
  provider(@Param('id', id) pid: string) {
    return this.infra.getProvider(pid);
  }
  @Put('providers/:id')
  limits(@CurrentUser() p: Principal, @Param('id', id) pid: string, @Body({ schema: limitsSchema }) b: z.infer<typeof limitsSchema>) {
    return this.infra.updateLimits(p.userId, pid, b);
  }
  @Post('providers/:id/rotate')
  @HttpCode(200)
  rotate(@CurrentUser() p: Principal, @Param('id', id) pid: string, @Body({ schema: tokenSchema }) b: z.infer<typeof tokenSchema>) {
    return this.infra.rotate(p.userId, pid, b.token);
  }
  @Post('providers/:id/test')
  @HttpCode(200)
  test(@CurrentUser() p: Principal, @Param('id', id) pid: string) {
    return this.infra.test(p.userId, pid);
  }
  @Post('providers/:id/disabled')
  @HttpCode(200)
  disabled(@CurrentUser() p: Principal, @Param('id', id) pid: string, @Body({ schema: disabledBody }) b: z.infer<typeof disabledBody>) {
    return this.infra.setDisabled(p.userId, pid, b.disabled);
  }
  @Get('providers/:id/catalog')
  catalog(@Param('id', id) pid: string) {
    return this.infra.catalog(pid);
  }
  @Get('providers/:id/remote-servers')
  remote(@Param('id', id) pid: string) {
    return this.infra.remoteServers(pid);
  }
  @Post('providers/:id/import')
  import(@CurrentUser() p: Principal, @Param('id', id) pid: string, @Body({ schema: importBody }) b: z.infer<typeof importBody>) {
    return this.infra.importServer(p.userId, pid, b.externalId);
  }

  @Get('ssh-keys')
  keys() {
    return this.infra.sshKeys();
  }
  @Post('ssh-keys')
  addKey(@CurrentUser() p: Principal, @Body({ schema: sshKeySchema }) b: z.infer<typeof sshKeySchema>) {
    return this.infra.addSshKey(p.userId, b);
  }
  @Post('ssh-keys/:id/active')
  @HttpCode(200)
  keyActive(@CurrentUser() p: Principal, @Param('id', id) kid: string, @Body({ schema: activeBody }) b: z.infer<typeof activeBody>) {
    return this.infra.setSshKeyActive(p.userId, kid, b.isActive);
  }

  @Get('installation-options')
  installationOptions() {
    return this.infra.installationOptions();
  }

  @Get('requests')
  requests(@Query({ schema: requestFilter }) q: z.infer<typeof requestFilter>) {
    return this.infra.requests(q.status);
  }
  @Post('requests')
  request(@CurrentUser() p: Principal, @Body({ schema: requestSchema }) b: z.infer<typeof requestSchema>) {
    return this.infra.createRequest(p.userId, b);
  }
  @Post('requests/:id/approve')
  @HttpCode(200)
  approve(@CurrentUser() p: Principal, @Param('id', id) rid: string, @Body({ schema: approveSchema }) b: z.infer<typeof approveSchema>) {
    return this.infra.approve(p.userId, rid, b);
  }
  @Post('requests/:id/reject')
  @HttpCode(200)
  reject(@CurrentUser() p: Principal, @Param('id', id) rid: string, @Body({ schema: decisionSchema }) b: z.infer<typeof decisionSchema>) {
    return this.infra.reject(p.userId, rid, b.note, 'REJECTED');
  }
  @Post('requests/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() p: Principal, @Param('id', id) rid: string, @Body({ schema: decisionSchema }) b: z.infer<typeof decisionSchema>) {
    return this.infra.reject(p.userId, rid, b.note, 'CANCELLED');
  }

  @Get('servers')
  servers(@Query({ schema: serverFilter }) q: z.infer<typeof serverFilter>) {
    return this.infra.servers(q.deleted === 'true');
  }
  @Get('servers/:id')
  server(@Param('id', id) sid: string) {
    return this.infra.server(sid);
  }
  @Post('servers/:id/refresh')
  @HttpCode(200)
  refresh(@CurrentUser() p: Principal, @Param('id', id) sid: string) {
    return this.infra.refresh(p.userId, sid);
  }
  @Post('servers/:id/power')
  @HttpCode(200)
  power(@CurrentUser() p: Principal, @Param('id', id) sid: string, @Body({ schema: powerSchema }) b: z.infer<typeof powerSchema>) {
    return this.infra.power(p.userId, sid, b.action);
  }
  @Post('servers/:id/delete')
  @HttpCode(200)
  remove(@CurrentUser() p: Principal, @Param('id', id) sid: string, @Body({ schema: deleteSchema }) b: z.infer<typeof deleteSchema>) {
    return this.infra.remove(p.userId, sid, b);
  }
  @Get('servers/:id/metrics')
  metrics(@Param('id', id) sid: string) {
    return this.infra.metrics(sid);
  }
}
