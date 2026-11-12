import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ENV, type Env } from '../config/env.js';

const IMAGE_TYPES: { mime: string; ext: string; magic: (b: Buffer) => boolean }[] = [
  { mime: 'image/jpeg', ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', ext: 'webp', magic: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Almacenamiento de archivos en disco local (volumen Docker en despliegue).
 * La clave incluye el tenant y un UUID aleatorio. El tipo se valida por los
 * "magic bytes", no por la extensión ni el Content-Type enviados.
 * Interfaz preparada para sustituirse por S3/MinIO sin cambiar los módulos.
 */
@Injectable()
export class StorageService {
  private readonly root: string;
  constructor(@Inject(ENV) private readonly env: Env) {
    this.root = resolve(env.STORAGE_DIR);
  }

  detectImage(buf: Buffer) {
    return IMAGE_TYPES.find((t) => t.magic(buf)) ?? null;
  }

  async saveImage(tenantId: string, buf: Buffer) {
    if (buf.length > MAX_IMAGE_BYTES) throw new BadRequestException('La imagen supera 5 MB');
    const type = this.detectImage(buf);
    if (!type) throw new BadRequestException('Formato no admitido: usa JPG, PNG o WEBP');
    const key = `${tenantId}/${randomUUID()}.${type.ext}`;
    const path = this.pathFor(key);
    await mkdir(join(this.root, tenantId), { recursive: true });
    await writeFile(path, buf, { flag: 'wx' });
    return { key, url: `${this.env.API_PUBLIC_URL}/api/v1/files/${key}`, mime: type.mime };
  }

  async read(key: string) {
    try {
      const buf = await readFile(this.pathFor(key));
      return { buf, type: this.detectImage(buf) };
    } catch {
      throw new NotFoundException('Archivo no encontrado');
    }
  }

  async remove(key: string) {
    await unlink(this.pathFor(key)).catch(() => undefined);
  }

  private pathFor(key: string) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(key)) throw new NotFoundException('Archivo no encontrado');
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root)) throw new NotFoundException('Archivo no encontrado');
    return p;
  }
}
