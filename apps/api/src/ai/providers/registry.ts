import { Injectable } from '@nestjs/common';
import { GeminiChatModel } from '../gemini.client.js';
import { AnthropicAdapter } from './anthropic.adapter.js';
import { DeepSeekAdapter, OpenAiAdapter } from './openai-compatible.adapter.js';
import type { AiProviderAdapter } from './types.js';

/** Proveedores de IA con adaptador: se registran aquí y en AiModule */
@Injectable()
export class AiProviders {
  private readonly map: Map<string, AiProviderAdapter>;
  constructor(gemini: GeminiChatModel, anthropic: AnthropicAdapter, openai: OpenAiAdapter, deepseek: DeepSeekAdapter) {
    this.map = new Map<string, AiProviderAdapter>([anthropic, gemini, openai, deepseek].map((a) => [a.key, a]));
  }
  get(key: string): AiProviderAdapter | undefined {
    return this.map.get(key);
  }
  list(): AiProviderAdapter[] {
    return [...this.map.values()];
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

export type CenterCategory = 'ai' | 'messaging' | 'automation' | 'support' | 'infrastructure' | 'payments' | 'email' | 'storage' | 'dns';

/**
 * Catálogo del Centro de APIs. `managedIn` dice dónde se configura hoy cada
 * integración; `planned` marca las que todavía NO tienen adaptador (se muestran
 * como no disponibles, sin botones). Integrar una API nueva exige escribir su
 * adaptador: no basta con pegar una clave.
 */
export const CENTER_CATALOG: { key: string; name: string; category: CenterCategory; managedIn: 'center' | 'whatsapp' | 'server' | 'webhooks' | 'planned'; note?: string }[] = [
  { key: 'anthropic', name: 'Anthropic Claude', category: 'ai', managedIn: 'center' },
  { key: 'gemini', name: 'Google Gemini', category: 'ai', managedIn: 'center' },
  { key: 'openai', name: 'OpenAI', category: 'ai', managedIn: 'center' },
  { key: 'deepseek', name: 'DeepSeek', category: 'ai', managedIn: 'center' },
  { key: 'whatsapp_cloud', name: 'WhatsApp Cloud API (Meta)', category: 'messaging', managedIn: 'whatsapp', note: 'Cada empresa conecta sus números en Integraciones › WhatsApp' },
  { key: 'n8n', name: 'n8n', category: 'automation', managedIn: 'server', note: 'Variables N8N_* del servidor' },
  { key: 'webhooks', name: 'Webhooks firmados', category: 'automation', managedIn: 'webhooks', note: 'Cada empresa registra sus URL en Integraciones' },
  { key: 'chatwoot', name: 'Chatwoot', category: 'support', managedIn: 'server', note: 'Variables CHATWOOT_* del servidor' },
  { key: 'smtp', name: 'Correo SMTP', category: 'email', managedIn: 'server', note: 'Variables SMTP_* del servidor' },
  { key: 'hetzner', name: 'Hetzner Cloud', category: 'infrastructure', managedIn: 'planned', note: 'Fase D' },
  { key: 'digitalocean', name: 'DigitalOcean', category: 'infrastructure', managedIn: 'planned', note: 'Evaluado en la fase D' },
  { key: 'aws', name: 'Amazon Web Services', category: 'infrastructure', managedIn: 'planned', note: 'Evaluado en la fase D' },
  { key: 'payments', name: 'Pasarela de pagos', category: 'payments', managedIn: 'planned', note: 'Fase C; depende del proveedor que elija Rick' },
  { key: 's3', name: 'Almacenamiento S3', category: 'storage', managedIn: 'planned' },
  { key: 'dns', name: 'DNS', category: 'dns', managedIn: 'planned', note: 'Fase F' },
];
