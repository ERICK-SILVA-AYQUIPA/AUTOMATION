import { noticeFor } from './renewals.service.js';
import { FIRST_RESPONSE_HOURS, responseDue, ticketNo } from './support.service.js';

const DAY = 86_400_000;
const now = new Date('2026-11-15T12:00:00Z');

describe('renovaciones: aviso que corresponde', () => {
  it('7, 3 y 1 día antes, al vencer y nada fuera de esas ventanas', () => {
    expect(noticeFor(new Date(now.getTime() + 10 * DAY), now)).toBeNull();
    expect(noticeFor(new Date(now.getTime() + 7 * DAY), now)).toBe('D7');
    expect(noticeFor(new Date(now.getTime() + 3.5 * DAY), now)).toBe('D7');
    expect(noticeFor(new Date(now.getTime() + 3 * DAY), now)).toBe('D3');
    expect(noticeFor(new Date(now.getTime() + 2 * 3_600_000), now)).toBe('D1');
    expect(noticeFor(new Date(now.getTime() - DAY), now)).toBe('EXPIRED');
    expect(noticeFor(new Date(now.getTime() - 31 * DAY), now)).toBeNull();
  });
});

describe('soporte: plazo de primera respuesta', () => {
  it('según la prioridad; no vence si ya se respondió o está resuelto', () => {
    expect(ticketNo(7)).toBe('SOP-00007');
    expect(FIRST_RESPONSE_HOURS.URGENT).toBeLessThan(FIRST_RESPONSE_HOURS.NORMAL);
    const old = new Date(Date.now() - 3 * 3_600_000);
    expect(responseDue({ priority: 'URGENT', createdAt: old, firstResponseAt: null, status: 'OPEN' }).overdue).toBe(true);
    expect(responseDue({ priority: 'NORMAL', createdAt: old, firstResponseAt: null, status: 'OPEN' }).overdue).toBe(false);
    expect(responseDue({ priority: 'URGENT', createdAt: old, firstResponseAt: new Date(), status: 'IN_PROGRESS' }).overdue).toBe(false);
    expect(responseDue({ priority: 'URGENT', createdAt: old, firstResponseAt: null, status: 'RESOLVED' }).overdue).toBe(false);
  });
});
