import { hasPermission, permissionsFor, PERMISSIONS } from './permissions.js';

describe('matriz de permisos', () => {
  it('solo el administrador general gestiona la plataforma', () => {
    expect(PERMISSIONS['platform:manage']).toEqual(['PLATFORM_ADMIN']);
    expect(hasPermission('TENANT_ADMIN', 'platform:manage')).toBe(false);
  });
  it('el administrador general no tiene permisos de negocio de una empresa', () => {
    expect(permissionsFor('PLATFORM_ADMIN')).toEqual(['platform:manage']);
  });
  it('vendedor: productos, pedidos, conversaciones y clientes; no usuarios ni integraciones', () => {
    const s = permissionsFor('SELLER');
    expect(s).toEqual(expect.arrayContaining(['products:read', 'orders:write', 'conversations:reply', 'customers:read']));
    expect(s).not.toEqual(expect.arrayContaining(['users:manage']));
    expect(s).not.toContain('integrations:manage');
    expect(s).not.toContain('products:write');
  });
  it('supervisor: supervisa y asigna conversaciones, consulta actividad', () => {
    const s = permissionsFor('SUPERVISOR');
    expect(s).toEqual(expect.arrayContaining(['conversations:assign', 'reports:read', 'users:read']));
    expect(s).not.toContain('users:manage');
  });
});
