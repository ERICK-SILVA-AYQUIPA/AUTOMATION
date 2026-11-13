import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../common/decorators/auth.decorators.js';
import { SystemService } from './system.service.js';

/** Versión, migraciones e historial de actualizaciones: solo el ADMINISTRADOR GENERAL */
@RequirePermission('platform:manage')
@Controller('platform/system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get()
  status() {
    return this.system.status();
  }
}
