import { addMonths, subscriptionAccess } from './subscription-access.js';

const now = new Date('2026-11-12T12:00:00Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

describe('subscriptionAccess', () => {
  it('prueba vigente: uso completo con días restantes', () => {
    const a = subscriptionAccess({ status: 'TRIALING', trialEndsAt: days(3.5), currentPeriodEnd: days(3.5) }, 3, now);
    expect(a).toMatchObject({ state: 'TRIAL', readOnly: false, daysLeft: 4 });
  });

  it('prueba vencida: solo lectura, sin gracia', () => {
    const a = subscriptionAccess({ status: 'TRIALING', trialEndsAt: days(-0.01), currentPeriodEnd: days(-0.01) }, 3, now);
    expect(a).toMatchObject({ state: 'EXPIRED', readOnly: true, daysLeft: 0 });
  });

  it('plan pagado vigente cuenta la gracia en los días restantes', () => {
    const a = subscriptionAccess({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: days(10) }, 3, now);
    expect(a).toMatchObject({ state: 'ACTIVE', readOnly: false, daysLeft: 13 });
  });

  it('plan vencido dentro de la gracia sigue operativo', () => {
    const a = subscriptionAccess({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: days(-1) }, 3, now);
    expect(a).toMatchObject({ state: 'GRACE', readOnly: false, daysLeft: 2 });
  });

  it('plan vencido tras la gracia (o PAST_DUE): solo lectura', () => {
    expect(subscriptionAccess({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: days(-3) }, 3, now)).toMatchObject({ state: 'EXPIRED', readOnly: true });
    expect(subscriptionAccess({ status: 'PAST_DUE', trialEndsAt: null, currentPeriodEnd: days(-4) }, 3, now)).toMatchObject({ state: 'EXPIRED', readOnly: true });
  });

  it('cancelada: solo lectura aunque el periodo no haya terminado', () => {
    expect(subscriptionAccess({ status: 'CANCELED', trialEndsAt: null, currentPeriodEnd: days(20) }, 3, now)).toMatchObject({ state: 'CANCELED', readOnly: true });
  });
});

describe('addMonths', () => {
  it('suma meses de calendario y ajusta fin de mes', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonths(new Date('2026-11-12T10:00:00Z'), 12).toISOString()).toBe('2027-11-12T10:00:00.000Z');
    expect(addMonths(new Date('2026-12-15T00:00:00Z'), 3).toISOString()).toBe('2027-03-15T00:00:00.000Z');
  });
});
