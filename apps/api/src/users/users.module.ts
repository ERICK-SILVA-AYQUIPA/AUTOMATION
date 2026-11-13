import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { ChatwootModule } from '../chatwoot/chatwoot.module.js';

@Module({ imports: [ChatwootModule], controllers: [UsersController], providers: [UsersService], exports: [UsersService] })
export class UsersModule {}
