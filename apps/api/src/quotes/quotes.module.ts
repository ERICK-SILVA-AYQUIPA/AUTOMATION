import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module.js';
import { CommerceController, PublicCommerceController } from './quotes.controller.js';
import { PaymentsService } from './payments.service.js';
import { QuotesService } from './quotes.service.js';

@Module({ imports: [MailModule], controllers: [CommerceController, PublicCommerceController], providers: [QuotesService, PaymentsService], exports: [PaymentsService] })
export class QuotesModule {}
