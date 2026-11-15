import { toolsFor } from '../ai/ai-tools.js';
import { COMMERCIAL_TOOLS } from '../commercial/agent.js';

/**
 * Política de §15: ningún agente de IA crea servidores, elimina infraestructura,
 * contrata servicios ni autoriza gastos o pagos. Sus herramientas son una lista
 * cerrada; agregar una nueva obliga a revisar esta prueba.
 */
const FORBIDDEN = /servidor|server|infra|instal|aprovision|provision|pago|cobr|gasto|presupuesto|contrat|eliminar|borrar|delete|credencial|token|clave/i;

describe('Política de herramientas de los agentes de IA', () => {
  it('el agente comercial solo informa y registra pedidos de contacto', () => {
    expect(COMMERCIAL_TOOLS.map((t) => t.name)).toEqual(['ver_planes', 'ver_producto', 'registrar_prospecto', 'solicitar_demostracion', 'solicitar_propuesta', 'derivar_a_vendedor']);
  });

  it('el asistente de cada empresa solo atiende a sus clientes (catálogo, pedidos, reservas)', () => {
    const all = toolsFor({ orders: true, reservations: true, volumePricing: true, reservationKind: 'TABLE', timezone: 'America/Lima' }).map((t) => t.name);
    expect(all.sort()).toEqual(['buscar_productos', 'consultar_disponibilidad', 'crear_pedido', 'crear_reserva', 'derivar_a_humano', 'ver_pedidos_del_cliente', 'ver_reservas_del_cliente']);
  });

  it('ninguna herramienta toca infraestructura, pagos, gastos ni credenciales', () => {
    const all = [...COMMERCIAL_TOOLS, ...toolsFor({ orders: true, reservations: true, volumePricing: true, reservationKind: 'TABLE', timezone: 'America/Lima' })];
    for (const t of all) expect(`${t.name}`).not.toMatch(FORBIDDEN);
  });
});
