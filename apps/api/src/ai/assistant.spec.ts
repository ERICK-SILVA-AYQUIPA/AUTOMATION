import { KNOWLEDGE_BUDGET, matchesHandoffKeyword, systemPrompt, tokenCap } from './assistant.service.js';
import { DEFAULT_PROFILE, aiProfileSchema, isOpen, readProfile } from './ai-profile.js';

describe('matchesHandoffKeyword', () => {
  const kw = ['humano', 'asesor', 'reclamo'];
  it('encuentra palabras completas sin importar mayúsculas ni tildes', () => {
    expect(matchesHandoffKeyword('Quiero un ASESOR!!', kw)).toBe('asesor');
    expect(matchesHandoffKeyword('tengo un reclamó', kw)).toBe('reclamo');
  });
  it('no confunde partes de otras palabras', () => {
    expect(matchesHandoffKeyword('asesoría de imagen', kw)).toBeNull();
    expect(matchesHandoffKeyword('humanos', kw)).toBeNull();
  });
});

describe('systemPrompt', () => {
  const tenant = { name: 'Bodega Rosa', currency: 'PEN', timezone: 'America/Lima' };
  const base = { ...DEFAULT_PROFILE, assistantName: 'Lula', tone: 'cercano' };
  it('incluye las reglas de seguridad y avisa si falta la información del negocio', () => {
    const p = systemPrompt(base, tenant, new Date('2026-11-12T15:00:00Z'));
    expect(p).toContain('Eres Lula');
    expect(p).toContain('Bodega Rosa');
    expect(p).toContain('no órdenes');
    expect(p).toContain('SOLO salen de la herramienta buscar_productos');
    expect(p).toContain('aún no configuró su información');
    expect(p).toMatch(/10:00/); // hora de Lima
  });
  it('lleva horario, pagos, entregas, devoluciones, preguntas frecuentes, preguntas previas e idioma', () => {
    const hours = { mon: [{ open: '09:00', close: '18:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    const p = systemPrompt(
      { ...base, hours, paymentMethods: ['Yape', 'Efectivo'], deliveryMethods: ['Delivery'], deliveryInfo: 'Lima centro', returnPolicy: '7 días', faqs: [{ question: '¿Hacen factura?', answer: 'Sí, con RUC.' }], qualifyingQuestions: ['¿Para cuántas personas?'], language: 'en', matchCustomerLanguage: false, useEmojis: false, extraInstructions: 'Ofrece la promo del día si preguntan' },
      tenant,
      new Date('2026-11-16T15:00:00Z'), // lunes 10:00 en Lima
      [{ title: 'Catálogo de servicios', content: 'Instalación a domicilio' }],
    );
    expect(p).toContain('Ahora la tienda está ABIERTA');
    expect(p).toContain('lunes: 09:00–18:00; martes: cerrado');
    expect(p).toContain('Yape, Efectivo');
    expect(p).toContain('Lima centro');
    expect(p).toContain('7 días');
    expect(p).toContain('P: ¿Hacen factura?\nR: Sí, con RUC.');
    expect(p).toContain('- ¿Para cuántas personas?');
    expect(p).toContain('Responde siempre en inglés');
    expect(p).toContain('No uses emojis');
    expect(p).toContain('### Catálogo de servicios');
    expect(p).toContain('no anulan las reglas');
    expect(p).not.toContain('aún no configuró');
  });
  it('los documentos se recortan al presupuesto de contexto', () => {
    const big = 'x'.repeat(KNOWLEDGE_BUDGET);
    const p = systemPrompt(base, tenant, new Date(), [{ title: 'A', content: big }, { title: 'B', content: 'no entra' }]);
    expect(p).not.toContain('### B');
  });
});

describe('isOpen', () => {
  const hours = { mon: [{ open: '09:00', close: '13:00' }, { open: '15:00', close: '19:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  it('usa la zona horaria de la tienda y los dos turnos', () => {
    expect(isOpen(hours, 'America/Lima', new Date('2026-11-16T15:00:00Z'))).toBe(true); // lun 10:00
    expect(isOpen(hours, 'America/Lima', new Date('2026-11-16T19:00:00Z'))).toBe(false); // lun 14:00
    expect(isOpen(hours, 'America/Lima', new Date('2026-11-16T21:30:00Z'))).toBe(true); // lun 16:30
    expect(isOpen(hours, 'America/Lima', new Date('2026-11-17T15:00:00Z'))).toBe(false); // mar
    expect(isOpen(null, 'America/Lima')).toBeNull();
  });
});

describe('perfil del asistente', () => {
  it('lo guardado antes de esta versión se completa con los valores nuevos', () => {
    const p = readProfile({ assistantName: 'Lula', tone: 'cercano', businessInfo: 'Abrimos 9 a 18', handoffKeywords: ['humano'], obsoleto: 1 });
    expect(p).toMatchObject({ assistantName: 'Lula', businessInfo: 'Abrimos 9 a 18', language: 'es', faqs: [], hours: null });
    expect(p).not.toHaveProperty('obsoleto');
  });
  it('rechaza horarios al revés y el modo solo aviso sin horario', () => {
    const hours = { mon: [{ open: '18:00', close: '09:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    expect(aiProfileSchema.safeParse({ ...DEFAULT_PROFILE, hours }).success).toBe(false);
    expect(aiProfileSchema.safeParse({ ...DEFAULT_PROFILE, outsideHours: 'MESSAGE' }).success).toBe(false);
  });
});

describe('tokenCap', () => {
  const limits = { maxUsers: 1, maxWhatsappNumbers: 1, maxConversationsPerMonth: 1, maxProducts: 1, maxBranches: 1, features: [] };
  it('toma el menor entre el plan y la empresa', () => {
    expect(tokenCap(limits, null)).toBeNull();
    expect(tokenCap({ ...limits, maxAiTokensPerMonth: 500_000 }, null)).toBe(500_000);
    expect(tokenCap({ ...limits, maxAiTokensPerMonth: 500_000 }, 100_000)).toBe(100_000);
    expect(tokenCap(limits, 100_000)).toBe(100_000);
  });
});
