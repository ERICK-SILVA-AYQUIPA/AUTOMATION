import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/decorators/auth.decorators.js';
import { StorageService } from './storage.service.js';

/**
 * Imágenes de catálogo. Públicas a propósito: WhatsApp debe poder descargarlas
 * para enviarlas al cliente. Las rutas contienen UUID aleatorios (no enumerables).
 */
@Public()
@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Get(':tenant/:file')
  async get(@Param('tenant') tenant: string, @Param('file') file: string, @Res() res: Response) {
    const { buf, type } = await this.storage.read(`${tenant}/${file}`);
    res.setHeader('Content-Type', type?.mime ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(buf);
  }
}
