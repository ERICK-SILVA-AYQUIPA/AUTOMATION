import { paramsFor } from '../center/params.js';
import { hintOf, statusFromHttp, validateFields, type FieldSpec } from './types.js';

const fields: FieldSpec[] = [
  { key: 'apiKey', label: 'API Key', secret: true, required: true, pattern: /^[\w-]{20,}$/ },
  { key: 'organization', label: 'Organization ID', secret: false, required: false, pattern: /^org-\w+$/ },
];

describe('Centro de APIs: validación de campos, estados y perfiles', () => {
  it('separa secretos de configuración y rechaza campos ajenos o mal formados', () => {
    expect(validateFields(fields, { apiKey: ' sk-0123456789abcdefghij ', organization: 'org-abc' })).toEqual({ secrets: { apiKey: 'sk-0123456789abcdefghij' }, config: { organization: 'org-abc' } });
    expect(validateFields(fields, {})).toBe('Falta API Key');
    expect(validateFields(fields, { apiKey: 'corta' })).toBe('API Key no tiene un formato válido');
    expect(validateFields(fields, { apiKey: 'sk-0123456789abcdefghij', endpoint: 'http://169.254.169.254' })).toBe('Campo no admitido: endpoint');
  });

  it('nunca muestra más de 4 caracteres de la clave', () => {
    expect(hintOf({ apiKey: 'sk-ant-1234567890-ABCD' })).toBe('…ABCD');
    expect(hintOf({ apiKey: 'corta' })).toBe('…');
  });

  it('traduce el código HTTP del proveedor al estado del panel', () => {
    expect([401, 403, 429, 500, undefined].map(statusFromHttp)).toEqual(['AUTH_ERROR', 'PERMISSION_DENIED', 'CONNECTED_WITH_WARNINGS', 'UNAVAILABLE', 'UNAVAILABLE']);
  });

  it('los perfiles fijan los parámetros; el personalizado ignora valores fuera de rango', () => {
    expect(paramsFor('ECONOMY', null)).toEqual({ maxOutputTokens: 1024 });
    expect(paramsFor('ADVANCED', { maxOutputTokens: 9 })).toEqual({ maxOutputTokens: 4096 });
    expect(paramsFor('CUSTOM', { maxOutputTokens: 3000, temperature: 0.3, effort: 'high' })).toEqual({ maxOutputTokens: 3000, temperature: 0.3, effort: 'high' });
    expect(paramsFor('CUSTOM', { maxOutputTokens: 99_999 })).toEqual({ maxOutputTokens: 2048 });
  });
});
