import { z } from 'zod';
import type { DatabaseService } from '../database/database.service.js';

/**
 * Textos de la página comercial y del agente (ADR 048). Los escribe el personal
 * de la plataforma en el panel: el código no trae titulares, testimonios ni
 * respuestas de venta inventados.
 */
const item = z.object({ title: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(600) });
const faq = z.object({ q: z.string().trim().min(1).max(300), a: z.string().trim().min(1).max(2000) });
const testimonial = z.object({
  name: z.string().trim().min(1).max(120),
  company: z.string().trim().max(160).nullable().optional(),
  quote: z.string().trim().min(1).max(1000),
  /** Fecha en que la persona autorizó publicarlo: sin ella no se guarda */
  authorizedAt: z.iso.date(),
});

const list = <T extends z.ZodType>(s: T, max: number) => z.array(s).max(max);
const parseList = <T extends z.ZodType>(s: T, v: unknown): z.infer<T>[] => {
  const r = z.array(s).safeParse(v);
  return r.success ? r.data : [];
};

const opt = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();

export const updateCommercialSchema = z
  .object({
    published: z.boolean(),
    headline: opt(160),
    subheadline: opt(400),
    problems: list(item, 8),
    benefits: list(item, 8),
    faqs: list(faq, 20),
    testimonials: list(testimonial, 12),
    contactEmail: z.email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
    contactWhatsapp: z
      .string()
      .trim()
      .transform((v) => v.replace(/[\s().-]/g, ''))
      .refine((v) => v === '' || /^\+?\d{6,20}$/.test(v), 'Número de WhatsApp no válido')
      .transform((v) => v || null)
      .nullable()
      .optional(),
    showPrices: z.boolean(),
    chatEnabled: z.boolean(),
    agentName: opt(60),
    agentInstructions: opt(4000),
    houseTenantId: z.uuid().nullable().optional(),
  })
  .refine((v) => !v.published || !!v.headline, { path: ['headline'], message: 'Para publicar la página escribe el titular' })
  .refine((v) => new Set(v.testimonials.map((t) => `${t.name}|${t.quote}`)).size === v.testimonials.length, { path: ['testimonials'], message: 'Hay testimonios repetidos' });
export type UpdateCommercialInput = z.infer<typeof updateCommercialSchema>;

export interface CommercialContent {
  published: boolean;
  headline: string | null;
  subheadline: string | null;
  problems: z.infer<typeof item>[];
  benefits: z.infer<typeof item>[];
  faqs: z.infer<typeof faq>[];
  testimonials: z.infer<typeof testimonial>[];
  contactEmail: string | null;
  contactWhatsapp: string | null;
  showPrices: boolean;
  chatEnabled: boolean;
  agentName: string | null;
  agentInstructions: string | null;
  houseTenantId: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
}

export async function readCommercial(db: DatabaseService): Promise<CommercialContent> {
  const r = await db.system.commercialSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  return {
    published: r.published,
    headline: r.headline,
    subheadline: r.subheadline,
    problems: parseList(item, r.problems),
    benefits: parseList(item, r.benefits),
    faqs: parseList(faq, r.faqs),
    testimonials: parseList(testimonial, r.testimonials),
    contactEmail: r.contactEmail,
    contactWhatsapp: r.contactWhatsapp,
    showPrices: r.showPrices,
    chatEnabled: r.chatEnabled,
    agentName: r.agentName,
    agentInstructions: r.agentInstructions,
    houseTenantId: r.houseTenantId,
    publishedAt: r.publishedAt,
    updatedAt: r.updatedAt,
  };
}

/** Empresa interna del agente comercial por WhatsApp (null si no hay) */
export async function houseTenantId(db: DatabaseService): Promise<string | null> {
  const r = await db.system.commercialSettings.findUnique({ where: { id: 1 }, select: { houseTenantId: true } });
  return r?.houseTenantId ?? null;
}
