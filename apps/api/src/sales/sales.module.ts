import { Module } from '@nestjs/common';
import { QuotesModule } from '../quotes/quotes.module.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';

@Module({ imports: [QuotesModule], controllers: [SalesController], providers: [SalesService], exports: [SalesService] })
export class SalesModule {}
