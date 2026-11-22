import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  organizationIdsOf,
  planFromSubscriber,
  type Subscriber,
} from '../src/billing/revenuecat.js';
import { setupTestApp, userCreated } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-21T18:00:00.000Z');
const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();

const subscriber = (s: Partial<Subscriber> = {}): Subscriber => ({
  entitlements: {},
  subscriptions: {},
  ...s,
});

describe('planFromSubscriber', () => {
  it('sin compras no decide nada', () => {
    expect(planFromSubscriber(subscriber(), now)).toBeNull();
  });

  it('una suscripción vigente', () => {
    const s = subscriber({
      entitlements: {
        pro: { expires_date: iso(30 * DAY), product_identifier: 'boba_pro:mensual' },
      },
      subscriptions: {
        'boba_pro:mensual': { expires_date: iso(30 * DAY), period_type: 'normal' },
      },
    });
    expect(planFromSubscriber(s, now)).toEqual({
      plan: 'pro',
      subscriptionStatus: 'active',
      currentPeriodEnd: new Date(iso(30 * DAY)),
      active: true,
    });
  });

  it('Max gana a Pro si ambos están vigentes', () => {
    const s = subscriber({
      entitlements: {
        pro: { expires_date: iso(DAY), product_identifier: 'boba_pro:mensual' },
        max: { expires_date: iso(300 * DAY), product_identifier: 'boba_max:anual' },
      },
    });
    expect(planFromSubscriber(s, now)?.plan).toBe('max');
  });

  it('prueba, cancelada aún vigente y problema de pago', () => {
    const base = (sub: Record<string, unknown>) =>
      planFromSubscriber(
        subscriber({
          entitlements: { pro: { expires_date: iso(DAY), product_identifier: 'p' } },
          subscriptions: { p: { expires_date: iso(DAY), ...sub } },
        }),
        now,
      )?.subscriptionStatus;
    expect(base({ period_type: 'trial' })).toBe('trialing');
    expect(base({ unsubscribe_detected_at: iso(-DAY) })).toBe('canceled');
    expect(base({ billing_issues_detected_at: iso(-DAY) })).toBe('past_due');
  });

  it('vencida: cancelada con el último vencimiento', () => {
    const s = subscriber({
      entitlements: { pro: { expires_date: iso(-DAY), product_identifier: 'p' } },
    });
    expect(planFromSubscriber(s, now)).toMatchObject({
      plan: 'pro',
      subscriptionStatus: 'canceled',
      currentPeriodEnd: new Date(iso(-DAY)),
      active: false,
    });
  });
});

it('organizationIdsOf toma ids de org (uuid) del evento', () => {
  const org = randomUUID();
  const other = randomUUID();
  expect(
    organizationIdsOf({
      id: 'e1',
      type: 'TRANSFER',
      app_user_id: '$RCAnonymousID:abc',
      aliases: [org, '$RCAnonymousID:abc'],
      transferred_to: [other],
    }),
  ).toEqual([org, other]);
});

const subscribers = new Map<string, Subscriber>();
const SECRET = 'whsec_test_1234567890';
const t = setupTestApp({
  billing: {
    fetchSubscriber: async (id) => subscribers.get(id) ?? subscriber(),
    webhookSecret: SECRET,
  },
});

const activePro = (days = 30) =>
  subscriber({
    entitlements: {
      pro: {
        expires_date: new Date(Date.now() + days * DAY).toISOString(),
        product_identifier: 'p',
      },
    },
    subscriptions: { p: { period_type: 'normal' } },
  });

const webhook = (body: object, secret = SECRET) =>
  request(t.app).post('/v1/billing/revenuecat').set('authorization', secret).send(body);

const event = (orgId: string, id: string = randomUUID()) => ({
  api_version: '1.0',
  event: { id, type: 'INITIAL_PURCHASE', app_user_id: orgId },
});

describe('cobro en la app (RevenueCat)', () => {
  beforeEach(() => subscribers.clear());

  it('el webhook exige el secreto', async () => {
    expect((await webhook(event(randomUUID()), 'otro-secreto-123456')).status).toBe(401);
  });

  it('una compra activa la org vencida y la sync se reanuda', async () => {
    const a = await t.pairedDevice({ plan: 'pro' });
    await t.admin().patch(`/organizations/${a.orgId}/plan`, {
      subscriptionStatus: 'canceled',
      currentPeriodEnd: new Date(Date.now() - DAY).toISOString(),
    });
    expect((await t.pull(a.token)).status).toBe(402);

    subscribers.set(a.orgId, activePro());
    const res = await webhook(event(a.orgId));
    expect(res.status).toBe(200);
    expect(res.body.organizations).toBe(1);

    const pulled = await t.pull(a.token);
    expect(pulled.status).toBe(200);
    expect(pulled.body.plan).toMatchObject({
      plan: 'pro',
      status: 'active',
      state: 'active',
    });
    const org = await t.db.organization.findUniqueOrThrow({ where: { id: a.orgId } });
    expect(org.billingSource).toBe('store');
  });

  it('un evento repetido no se reprocesa', async () => {
    const a = await t.pairedDevice({ plan: 'pro' });
    subscribers.set(a.orgId, activePro());
    const body = event(a.orgId, 'evt-1');
    expect((await webhook(body)).body.duplicate).toBeUndefined();
    expect((await webhook(body)).body.duplicate).toBe(true);
    expect(await t.db.billingEvent.count()).toBe(1);
  });

  it('una org desconocida se ignora sin error', async () => {
    const res = await webhook(event(randomUUID()));
    expect(res.status).toBe(200);
    expect(res.body.organizations).toBe(0);
  });

  it('un plan manual no se pisa con una suscripción ya vencida', async () => {
    const a = await t.pairedDevice({ plan: 'max' });
    subscribers.set(
      a.orgId,
      subscriber({
        entitlements: {
          pro: {
            expires_date: new Date(Date.now() - DAY).toISOString(),
            product_identifier: 'p',
          },
        },
      }),
    );
    await webhook(event(a.orgId));
    const org = await t.db.organization.findUniqueOrThrow({ where: { id: a.orgId } });
    expect(org).toMatchObject({
      plan: 'max',
      subscriptionStatus: 'active',
      billingSource: 'manual',
    });
  });

  it('/v1/billing/sync: solo admin, y funciona con el plan vencido', async () => {
    const a = await t.pairedDevice({ plan: 'pro' });
    const adminId = randomUUID();
    const cashierId = randomUUID();
    await t.push(a.token, [
      userCreated('admin', adminId),
      userCreated('cashier', cashierId),
    ]);
    await t.admin().patch(`/organizations/${a.orgId}/plan`, {
      subscriptionStatus: 'canceled',
      currentPeriodEnd: new Date(Date.now() - DAY).toISOString(),
    });
    subscribers.set(a.orgId, activePro());

    const sync = (userId: string) =>
      request(t.app)
        .post('/v1/billing/sync')
        .set('authorization', `Bearer ${a.token}`)
        .set('x-boba-user', userId);
    expect((await sync(cashierId)).status).toBe(403);
    const res = await sync(adminId);
    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({ plan: 'pro', state: 'active' });
  });
});
