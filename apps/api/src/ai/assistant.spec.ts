import { matchesHandoffKeyword, systemPrompt } from './assistant.service.js';

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
  const settings = { isEnabled: true, assistantName: 'Lula', tone: 'cercano', welcomeMessage: null, businessInfo: null, handoffKeywords: [] };
  it('incluye las reglas de seguridad y avisa si falta la información del negocio', () => {
    const p = systemPrompt(settings, { name: 'Bodega Rosa', currency: 'PEN', timezone: 'America/Lima' }, new Date('2026-11-12T15:00:00Z'));
    expect(p).toContain('Eres Lula');
    expect(p).toContain('Bodega Rosa');
    expect(p).toContain('NO CONFIABLE');
    expect(p).toContain('SOLO salen de la herramienta buscar_productos');
    expect(p).toContain('no configurada');
    expect(p).toMatch(/10:00/); // hora de Lima
  });
});
