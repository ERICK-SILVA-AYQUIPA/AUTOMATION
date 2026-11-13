import { Module } from '@nestjs/common';
import { AutomationsController } from './automations.controller.js';

/** Rutas del panel para automatizaciones (solo en la API; el worker no expone HTTP) */
@Module({ controllers: [AutomationsController] })
export class AutomationsApiModule {}
