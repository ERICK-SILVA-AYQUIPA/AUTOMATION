import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';

@Module({ controllers: [NotificationsController] })
export class NotificationsModule {}
