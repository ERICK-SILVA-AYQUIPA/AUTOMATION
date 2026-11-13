import { z } from 'zod';

/**
 * Configuración del asistente que define la empresa (ADR 041). Se guarda como
 * documento validado: el borrador se prueba y luego se publica. Nada de esto
 * puede anular las reglas fijas del sistema (precios y stock solo desde el
 * catálogo, mensajes del cliente no confiables, sin descuentos ni cambios).
 */
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];
const DAY_NAME: Record<Day, string> = { mon: 'lunes', tue: 'martes', wed: 'miércoles', thu: 'jueves', fri: 'viernes', sat: 'sábado', sun: 'domingo' };
export const LANGUAGES = { es: 'español', en: 'inglés', pt: 'portugués' } as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora en formato HH:MM');
const range = z.object({ open: time, close: time }).strict().refine((r) => r.open < r.close, { message: 'La hora de cierre debe ser posterior a la de apertura', path: ['close'] });
const text = (max: number) => z.string().trim().max(max);
/** Horario semanal: hasta dos turnos por día (también lo usan las reservas) */
export const weeklyHoursSchema = z.object(Object.fromEntries(DAYS.map((d) => [d, z.array(range).max(2)])) as Record<Day, z.ZodArray<typeof range>>).strict();
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;
const list = (maxItems: number, maxLen: number) => z.array(z.string().trim().min(1).max(maxLen)).max(maxItems);

export const aiProfileSchema = z
  .object({
    assistantName: z.string().trim().min(1).max(60),
    tone: z.string().trim().min(2).max(120),
    useEmojis: z.boolean(),
    language: z.enum(Object.keys(LANGUAGES) as [keyof typeof LANGUAGES, ...(keyof typeof LANGUAGES)[]]),
    matchCustomerLanguage: z.boolean(),
    welcomeMessage: text(500),
    businessInfo: text(6000),
    /** null = sin horario configurado (el asistente no afirma si está abierto) */
    hours: weeklyHoursSchema.nullable(),
    /** Fuera de horario: ANSWER = atiende igual y lo menciona; MESSAGE = solo envía el aviso */
    outsideHours: z.enum(['ANSWER', 'MESSAGE']),
    outsideHoursMessage: text(500),
    paymentMethods: list(15, 80),
    deliveryMethods: list(15, 80),
    deliveryInfo: text(2000),
    returnPolicy: text(2000),
    faqs: z.array(z.object({ question: z.string().trim().min(3).max(200), answer: z.string().trim().min(1).max(1000) }).strict()).max(40),
    qualifyingQuestions: list(8, 200),
    handoffKeywords: list(30, 40),
    handoffMessage: z.string().trim().min(5).max(500),
    handoffOutsideHoursMessage: text(500),
    extraInstructions: text(2000),
  })
  .strict()
  .refine((p) => p.outsideHours !== 'MESSAGE' || (p.hours && p.outsideHoursMessage), { message: 'Para responder solo con un aviso fuera de horario, configura el horario y el aviso', path: ['outsideHoursMessage'] });
export type AiProfile = z.infer<typeof aiProfileSchema>;

export const DEFAULT_PROFILE: AiProfile = {
  assistantName: 'Asistente',
  tone: 'amable y profesional',
  useEmojis: true,
  language: 'es',
  matchCustomerLanguage: true,
  welcomeMessage: '',
  businessInfo: '',
  hours: null,
  outsideHours: 'ANSWER',
  outsideHoursMessage: '',
  paymentMethods: [],
  deliveryMethods: [],
  deliveryInfo: '',
  returnPolicy: '',
  faqs: [],
  qualifyingQuestions: [],
  handoffKeywords: ['humano', 'asesor', 'persona', 'reclamo', 'queja'],
  handoffMessage: 'Te comunico con una persona de nuestro equipo, en breve te responde. 🙌',
  handoffOutsideHoursMessage: '',
  extraInstructions: '',
};

/** Lo guardado sobre los valores por defecto (los campos nuevos de versiones posteriores toman su valor inicial). */
export function readProfile(stored: unknown): AiProfile {
  const saved = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const merged = { ...DEFAULT_PROFILE, ...Object.fromEntries(Object.entries(saved).filter(([k]) => k in DEFAULT_PROFILE)) };
  const parsed = aiProfileSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_PROFILE;
}

/** ¿La tienda está abierta ahora en su zona horaria? null si no hay horario configurado. */
export function isOpen(hours: AiProfile['hours'], timezone: string, now = new Date()): boolean | null {
  if (!hours) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = get('weekday').toLowerCase().slice(0, 3) as Day;
  const hm = `${get('hour')}:${get('minute')}`;
  return (hours[day] ?? []).some((r) => r.open <= hm && hm < r.close);
}

export function describeHours(hours: NonNullable<AiProfile['hours']>): string {
  return DAYS.map((d) => `${DAY_NAME[d]}: ${hours[d].length ? hours[d].map((r) => `${r.open}–${r.close}`).join(' y ') : 'cerrado'}`).join('; ');
}

/** ¿Hay algo de información del negocio? (tarea de puesta en marcha) */
export const hasBusinessInfo = (p: AiProfile) =>
  !!(p.businessInfo || p.deliveryInfo || p.returnPolicy || p.paymentMethods.length || p.deliveryMethods.length || p.faqs.length || p.hours);
