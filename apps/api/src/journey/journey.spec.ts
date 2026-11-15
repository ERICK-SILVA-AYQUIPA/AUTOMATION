import { type JourneyData, buildJourney } from './journey.js';

const lead: JourneyData['lead'] = { id: 'l1', number: 7, name: 'Ana', company: 'Distribuidora Ana', email: 'ana@x.pe', status: 'QUALIFIED', interestPlan: null, interestMode: null, interestModules: [], tenantId: null };
const empty: JourneyData = { lead, quote: null, payment: null, installation: null, tenant: null, onboarding: null, run: null };
const states = (d: JourneyData) => buildJourney(d).steps.map((s) => s.state);

describe('asistente «Nueva venta e instalación»', () => {
  it('un prospecto recién registrado está en el paso 2 y lo posterior al pago espera', () => {
    const j = buildJourney(empty);
    expect(j.steps).toHaveLength(12);
    expect(j.current).toBe(2);
    expect(states(empty)).toEqual(['done', 'current', 'pending', 'pending', 'pending', 'pending', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked']);
    expect(j.steps[4]!.action).toEqual({ label: 'Nueva cotización', href: '/plataforma/cotizaciones/nueva?lead=l1' });
  });

  it('un comprobante subido no cuenta como pago: pide validarlo contra la cuenta', () => {
    const d: JourneyData = { ...empty, quote: { id: 'q1', number: 3, status: 'ACCEPTED', planCode: 'PROFESSIONAL', deploymentMode: 'DEDICATED', modules: ['catalog', 'orders'] }, payment: { id: 'p1', number: 4, status: 'PROOF_SUBMITTED' } };
    const j = buildJourney(d);
    expect(j.current).toBe(6);
    expect(j.steps[5]!.missing).toEqual(['Validar el comprobante contra la cuenta (el comprobante solo no prueba el pago)']);
    expect(j.steps[5]!.action).toEqual({ label: 'Validar pago', href: '/plataforma/cotizaciones/pagos/p1' });
  });

  it('dedicada: sigue la instalación automática hasta la entrega y la puesta en marcha que reporta', () => {
    const base: JourneyData = {
      ...empty,
      quote: { id: 'q1', number: 3, status: 'ACCEPTED', planCode: 'PROFESSIONAL', deploymentMode: 'DEDICATED', modules: ['catalog'] },
      payment: { id: 'p1', number: 4, status: 'PAID' },
      installation: { id: 'i1', number: 5, status: 'IN_PROGRESS', deploymentMode: 'DEDICATED' },
      tenant: { id: 't1', name: 'Distribuidora Ana', status: 'ONBOARDING', deploymentMode: 'DEDICATED' },
    };
    let j = buildJourney(base);
    expect(j.current).toBe(7);
    expect(j.steps[6]!.action).toEqual({ label: 'Registrar instalación', href: '/plataforma/aprovisionamiento?orden=i1' });
    const run = { id: 'r1', number: 9, status: 'CREATING_INFRA', stoppedAt: null, lastError: null, needs: null, domain: 'ventas.ana.pe', serverRequest: { number: 2, status: 'PENDING_APPROVAL' }, server: null, lastReport: null, lastReportAt: null };
    j = buildJourney({ ...base, run });
    expect(j.current).toBe(8);
    expect(j.steps[7]!.missing).toEqual(['Aprobar el gasto del servidor en Infraestructura']);
    j = buildJourney({ ...base, run: { ...run, status: 'CONFIGURING_SERVER', serverRequest: { number: 2, status: 'CREATED' }, server: { name: 'aisa-9-ventas-ana-pe', ipv4: '203.0.113.5', deletedAt: null } } });
    expect(j.current).toBe(9);
    expect(j.steps[8]!.missing).toEqual(['Registro DNS A: ventas.ana.pe → 203.0.113.5']);
    const report = {
      version: '0.16.0', at: '2026-11-15T10:00:00.000Z', healthy: true,
      tenants: [{ name: 'Distribuidora Ana', status: 'ACTIVE', activeProducts: 4, enabledAutomations: 2, integrations: [{ key: 'ai' as const, status: 'connected' as const, detail: 'Gemini' }], tasks: [{ key: 'whatsapp_verified', label: 'WhatsApp: credenciales verificadas con Meta', done: true, required: true }, { key: 'whatsapp_webhook', label: 'WhatsApp: llegó el primer aviso de Meta (webhook)', done: false, required: true }] }],
    };
    j = buildJourney({ ...base, run: { ...run, status: 'DELIVERED', serverRequest: { number: 2, status: 'CREATED' }, server: { name: 's', ipv4: '203.0.113.5', deletedAt: null }, lastReport: report, lastReportAt: new Date() } });
    expect(j.current).toBe(10);
    expect(j.steps[9]!.missing).toEqual(['WhatsApp: llegó el primer aviso de Meta (webhook)']);
    expect(j.steps[11]!.state).toBe('done');
    report.tenants[0]!.tasks[1]!.done = true;
    j = buildJourney({ ...base, run: { ...run, status: 'DELIVERED', serverRequest: { number: 2, status: 'CREATED' }, server: { name: 's', ipv4: '203.0.113.5', deletedAt: null }, lastReport: report, lastReportAt: new Date() } });
    expect(j.done).toBe(12);
  });

  it('SaaS: no pide servidor y entrega al activar la empresa con la puesta en marcha completa', () => {
    const d: JourneyData = {
      ...empty,
      quote: { id: 'q1', number: 3, status: 'ACCEPTED', planCode: 'BASIC', deploymentMode: 'SAAS', modules: ['catalog'] },
      payment: { id: 'p1', number: 4, status: 'PAID' },
      installation: { id: 'i1', number: 5, status: 'AUTHORIZED', deploymentMode: 'SAAS' },
      tenant: { id: 't1', name: 'Ana', status: 'ONBOARDING', deploymentMode: 'SAAS' },
      onboarding: [{ key: 'whatsapp_verified', label: 'WhatsApp verificado', done: true, required: true }, { key: 'whatsapp_webhook', label: 'Webhook', done: true, required: true }, { key: 'ai_provider', label: 'IA', done: false, required: false }],
    };
    let j = buildJourney(d);
    expect(j.steps[7]!.state).toBe('skipped');
    expect(j.current).toBe(10);
    expect(j.steps[9]!.missing).toEqual(['IA conectada y probada (clave de Gemini u otro proveedor en Integraciones)']);
    j = buildJourney({ ...d, tenant: { ...d.tenant!, status: 'ACTIVE' }, onboarding: d.onboarding!.map((t) => ({ ...t, done: true })) });
    expect(j.done).toBe(12);
  });
});
