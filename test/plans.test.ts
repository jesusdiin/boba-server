import { describe, expect, it } from 'vitest';

import {
  entitlementsOf,
  GRACE_DAYS,
  PLAN_LIMITS,
  type OrgPlanFields,
} from '../src/plans.js';

const DAY = 24 * 60 * 60 * 1000;
const end = new Date('2026-12-01T06:00:00.000Z');
const org = (o: Partial<OrgPlanFields> = {}): OrgPlanFields => ({
  plan: 'pro',
  subscriptionStatus: 'active',
  currentPeriodEnd: end,
  limitOverrides: null,
  ...o,
});
const at = (ms: number) => new Date(end.getTime() + ms);

describe('entitlementsOf', () => {
  it('sin vencimiento siempre está activo', () => {
    const e = entitlementsOf(org({ currentPeriodEnd: null }), new Date('2030-01-01'));
    expect(e.state).toBe('active');
    expect(e.graceUntil).toBeNull();
  });

  it('activo → gracia → vencido en los bordes', () => {
    expect(entitlementsOf(org(), at(-1)).state).toBe('active');
    expect(entitlementsOf(org(), at(0)).state).toBe('grace');
    expect(entitlementsOf(org(), at(GRACE_DAYS * DAY - 1)).state).toBe('grace');
    expect(entitlementsOf(org(), at(GRACE_DAYS * DAY)).state).toBe('lapsed');
  });

  it('la prueba vence igual que un periodo pagado', () => {
    const trial = org({ subscriptionStatus: 'trialing' });
    expect(entitlementsOf(trial, at(-DAY)).state).toBe('active');
    expect(entitlementsOf(trial, at(DAY)).state).toBe('grace');
    expect(entitlementsOf(trial, at(GRACE_DAYS * DAY)).state).toBe('lapsed');
  });

  it('un pago atrasado avisa antes del fin del periodo', () => {
    expect(entitlementsOf(org({ subscriptionStatus: 'past_due' }), at(-DAY)).state).toBe(
      'grace',
    );
  });

  it('cancelado respeta lo pagado y no tiene gracia', () => {
    const canceled = org({ subscriptionStatus: 'canceled' });
    expect(entitlementsOf(canceled, at(-1)).state).toBe('active');
    expect(entitlementsOf(canceled, at(0)).state).toBe('lapsed');
    expect(
      entitlementsOf(
        org({ subscriptionStatus: 'canceled', currentPeriodEnd: null }),
        at(0),
      ).state,
    ).toBe('lapsed');
  });

  it('límites del plan con ajustes por organización', () => {
    expect(entitlementsOf(org(), at(-1)).limits).toEqual(PLAN_LIMITS.pro);
    expect(entitlementsOf(org({ plan: 'max' }), at(-1)).limits).toEqual(PLAN_LIMITS.max);
    expect(
      entitlementsOf(org({ limitOverrides: { devices: 5 } }), at(-1)).limits,
    ).toEqual({
      branches: 1,
      devices: 5,
    });
    // Un ajuste inválido se ignora (no rompe el acceso).
    expect(
      entitlementsOf(org({ limitOverrides: { devices: -1 } }), at(-1)).limits,
    ).toEqual(PLAN_LIMITS.pro);
  });
});
