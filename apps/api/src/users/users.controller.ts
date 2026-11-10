import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { UsersService } from './users.service.js';
import { inviteUserSchema, updateUserSchema, type InviteUserInput, type UpdateUserInput } from './users.schemas.js';

const uuid = { schema: z.uuid() };

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermission('users:read')
  @Get()
  list(@TenantUser() p: TenantPrincipal) {
    return this.users.list(p);
  }

  @RequirePermission('users:read')
  @Get(':id')
  get(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    return this.users.get(p, id);
  }

  @RequirePermission('users:manage')
  @Post()
  invite(@TenantUser() p: TenantPrincipal, @Body({ schema: inviteUserSchema }) body: InviteUserInput) {
    return this.users.invite(p, body);
  }

  @RequirePermission('users:manage')
  @HttpCode(202)
  @Post(':id/resend-invitation')
  async resend(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    await this.users.resendInvitation(p, id);
    return { message: 'Invitación reenviada' };
  }

  @RequirePermission('users:manage')
  @Patch(':id')
  update(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @Body({ schema: updateUserSchema }) body: UpdateUserInput) {
    return this.users.update(p, id, body);
  }
}
