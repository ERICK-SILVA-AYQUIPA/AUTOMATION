import { createHmac } from 'node:crypto';

/**
 * Firma de cada entrega: cabecera `X-AISA-Signature: t=<unix>,v1=<hex>` con
 * HMAC-SHA256(secreto, `${t}.${cuerpo}`). El receptor recalcula y rechaza
 * firmas de más de 5 minutos para evitar reenvíos.
 */
export function signWebhook(secret: string, body: string, now = Date.now()) {
  const t = Math.floor(now / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
