import { Global, Module } from '@nestjs/common';
import { AutomationEvents } from './automation-events.service.js';

@Global()
@Module({ providers: [AutomationEvents], exports: [AutomationEvents] })
export class AutomationsModule {}
