import { createRequire } from 'node:module';

/**
 * Versión de la aplicación (apps/api/package.json). Se incluye en cada paquete
 * de entrega y la consultan las actualizaciones (fase 9).
 */
export const APP_VERSION: string = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
