import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { TRIAL_DAYS } from '../src/plans.js';
import { setupTestApp, userCreated } from './helpers.js';

const t = setupTestApp();
const DAY = 24 * 60 * 60 * 1000;

/// Org Pro con una sucursal y su primer equipo.
const proDevice = () => t.pairedDevice({ plan: 'pro' });

const lapse = (orgId: string) =>
  t.admin().patch(`/organizations/${orgId}/plan`, {
    subscriptionStatus: 'canceled',
    currentPeriodEnd: new Date(Date.now() - DAY).toISOString(),
  });

describe('planes y límites', () => {
  it('un negocio nuevo arranca con la prueba de Pro y el pull trae el plan', async () => {
    const before = Date.now();
    const signup = (await t.signup()).body;
    const pulled = await t.pull(signup.token);
    expect(pulled.status).toBe(200);
    expect(pulled.body.plan).toMatchObject({
      plan: 'pro',
      status: 'trialing',
      state: 'active',
      limits: { branches: 1, devices: 3 },
    });
    const end = Date.parse(pulled.body.plan.periodEnd);
    expect(end).toBeGreaterThanOrEqual(before + TRIAL_DAYS * DAY);
    expect(end).toBeLessThan(before + (TRIAL_DAYS + 1) * DAY);
  });

  it('Pro permite 3 equipos; revocar uno libera el cupo', async () => {
    const a = await proDevice();
    await t.pairAnother(a.branchId);
    const third = await t.pairAnother(a.branchId);
    expect(third.token).toBeTruthy();

    const { code } = (await t.admin().post(`/branches/${a.branchId}/pairing-codes`)).body;
    const fourth = await request(t.app)
      .post('/v1/devices/pair')
      .send({ code, deviceName: 'iPad 4' });
    expect(fourth.status).toBe(403);
    expect(fourth.body.error).toMatchObject({
      code: 'plan_limit',
      details: { limit: 'devices', max: 3, used: 3 },
    });

    await t.admin().post(`/devices/${third.deviceId}/revoke`);
    const retry = await request(t.app)
      .post('/v1/devices/pair')
      .send({ code, deviceName: 'iPad 4' });
    expect(retry.status).toBe(201);
  });

  it('el código de emparejamiento desde la app ya avisa del límite', async () => {
    const a = await proDevice();
    const adminId = randomUUID();
    await t.push(a.token, [userCreated('admin', adminId)]);
    await t.pairAnother(a.branchId);
    await t.pairAnother(a.branchId);
    const res = await t.branch(a.token, adminId).post('/pairing-codes');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('plan_limit');
  });

  it('Pro permite una sucursal; Max tres', async () => {
    const a = await proDevice();
    const second = await t
      .admin()
      .post(`/organizations/${a.orgId}/branches`, { name: 'Norte' });
    expect(second.status).toBe(403);
    expect(second.body.error.details).toMatchObject({ limit: 'branches', max: 1 });

    await t.admin().patch(`/organizations/${a.orgId}/plan`, { plan: 'max' });
    expect(
      (await t.admin().post(`/organizations/${a.orgId}/branches`, { name: 'Norte' }))
        .status,
    ).toBe(201);
  });

  it('vencido pausa la nube pero deja administrar los equipos', async () => {
    const a = await proDevice();
    const adminId = randomUUID();
    await t.push(a.token, [userCreated('admin', adminId)]);
    await lapse(a.orgId);

    const push = await t.push(a.token, [userCreated('cashier')]);
    expect(push.status).toBe(402);
    expect(push.body.error).toMatchObject({
      code: 'subscription_inactive',
      details: { plan: { state: 'lapsed', status: 'canceled' } },
    });
    expect((await t.pull(a.token)).status).toBe(402);
    expect((await t.snapshot(a.token, a.branchId)).status).toBe(402);
    const media = await request(t.app)
      .get('/v1/media/0190f0e0-0000-7000-8000-000000000000')
      .set('authorization', `Bearer ${a.token}`);
    expect(media.status).toBe(402);

    // Revocar equipos para ajustarse al plan sigue funcionando.
    expect((await t.branch(a.token, adminId).get('/devices')).status).toBe(200);
    // Pero no se suman equipos.
    expect((await t.branch(a.token, adminId).post('/pairing-codes')).status).toBe(402);
  });

  it('reactivar el plan reanuda la sync', async () => {
    const a = await proDevice();
    await lapse(a.orgId);
    expect((await t.pull(a.token)).status).toBe(402);

    const res = await t.admin().patch(`/organizations/${a.orgId}/plan`, {
      subscriptionStatus: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * DAY).toISOString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.plan.state).toBe('active');
    expect((await t.pull(a.token)).status).toBe(200);
  });

  it('admin muestra plan y uso', async () => {
    const a = await proDevice();
    await t.pairAnother(a.branchId);
    const res = await t.admin().get(`/organizations/${a.orgId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      plan: { plan: 'pro', status: 'active', state: 'active', periodEnd: null },
      usage: { branches: 1, devices: 2 },
    });
  });

  it('valida el cambio de plan', async () => {
    const a = await proDevice();
    const res = await t.admin().patch(`/organizations/${a.orgId}/plan`, { plan: 'gold' });
    expect(res.status).toBe(400);
  });
});
