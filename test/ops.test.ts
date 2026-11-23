import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { envelope, PANEL_ORIGIN, sale, setupTestApp, shiftOpened, userCreated } from './helpers.js';

const t = setupTestApp();

/// Venta de hoy por [cents] (las del helper son de agosto: fuera de 30 días).
function recentSale(shiftId: string, cents: number) {
  const e = sale(shiftId);
  const row = (e.payload as unknown as { sale: Record<string, unknown> }).sale;
  Object.assign(row, {
    subtotalCents: cents,
    totalCents: cents,
    createdAtUtc: new Date().toISOString(),
  });
  return e;
}

/// Operador creado con la API admin (como `pnpm cli operator:create`).
async function operator(email = 'ops@boba.test') {
  const res = await t.admin().post('/operators', { email, name: 'Jesús' });
  expect(res.status).toBe(201);
  return { email, password: res.body.password as string };
}

/// Sesión del panel: el agente guarda la cookie.
async function signedIn() {
  const op = await operator();
  const agent = request.agent(t.app);
  const res = await agent
    .post('/v1/ops/login')
    .set('origin', PANEL_ORIGIN)
    .send({ email: op.email, password: op.password });
  expect(res.status).toBe(200);
  return agent;
}

describe('sesión del operador', () => {
  it('entra con correo y contraseña; la cookie es httpOnly', async () => {
    const op = await operator();
    const res = await request(t.app)
      .post('/v1/ops/login')
      .send({ email: 'OPS@boba.test', password: op.password });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/boba_ops=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/v1\/ops/);
  });

  it('contraseña incorrecta → 401 y se frena', async () => {
    const op = await operator();
    const bad = await request(t.app)
      .post('/v1/ops/login')
      .send({ email: op.email, password: 'nope' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_credentials');
  });

  it('sin sesión → 401; con sesión ve /me; logout la cierra', async () => {
    expect((await request(t.app).get('/v1/ops/stats')).status).toBe(401);
    const agent = await signedIn();
    expect((await agent.get('/v1/ops/me')).body).toMatchObject({ email: 'ops@boba.test' });
    await agent.post('/v1/ops/logout').send({});
    expect((await agent.get('/v1/ops/me')).status).toBe(401);
  });

  it('un operador deshabilitado ya no entra', async () => {
    const agent = await signedIn();
    await t.db.operator.updateMany({ data: { disabledAt: new Date() } });
    expect((await agent.get('/v1/ops/me')).status).toBe(401);
  });

  it('cambia su contraseña', async () => {
    const op = await operator();
    const agent = request.agent(t.app);
    await agent.post('/v1/ops/login').send(op);
    const res = await agent
      .post('/v1/ops/me/password')
      .send({ current: op.password, next: 'una-clave-larga' });
    expect(res.status).toBe(200);
    const again = await request(t.app)
      .post('/v1/ops/login')
      .send({ email: op.email, password: 'una-clave-larga' });
    expect(again.status).toBe(200);
  });
});

describe('CORS y CSRF', () => {
  it('el origen del panel recibe CORS con credenciales; otro no', async () => {
    const pre = await request(t.app)
      .options('/v1/ops/stats')
      .set('origin', PANEL_ORIGIN)
      .set('access-control-request-method', 'GET');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(PANEL_ORIGIN);
    expect(pre.headers['access-control-allow-credentials']).toBe('true');

    const evil = await request(t.app)
      .options('/v1/ops/stats')
      .set('origin', 'https://evil.test');
    expect(evil.status).toBe(403);
  });

  it('una escritura desde otro origen o sin JSON se rechaza', async () => {
    const agent = await signedIn();
    const res = await agent.post('/v1/ops/logout').set('origin', 'https://evil.test').send({});
    expect(res.status).toBe(403);
    const form = await agent
      .post('/v1/ops/logout')
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('a=1');
    expect(form.status).toBe(415);
  });
});

describe('estadísticas y negocios', () => {
  it('cuenta por segmento, MRR, ventas a 30 días e inactivos', async () => {
    // De pago (Max), en prueba (registro) y vencido.
    const paid = await t.pairedDevice({ plan: 'max' });
    await t.admin().patch(`/organizations/${paid.orgId}/plan`, {
      plan: 'max',
      subscriptionStatus: 'active',
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    });
    const owner = userCreated('owner');
    await t.push(paid.token, [owner, shiftOpened('s1'), recentSale('s1', 6500)]);
    const trial = (await t.signup({ organizationName: 'Té de Ana' })).body;
    const lapsed = await t.pairedDevice();
    await t.admin().patch(`/organizations/${lapsed.orgId}/plan`, {
      subscriptionStatus: 'past_due',
      currentPeriodEnd: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });

    const agent = await signedIn();
    const stats = (await agent.get('/v1/ops/stats')).body;
    expect(stats.organizations).toBe(3);
    expect(stats.bySegment).toMatchObject({ paid: 1, trial: 1, lapsed: 1 });
    expect(stats.mrrCents).toBe(34900);
    expect(stats.sales30dCents).toBe(6500);
    expect(stats.devices.active24h).toBeGreaterThanOrEqual(1);
    expect(stats.signups).toHaveLength(12);

    const list = (await agent.get('/v1/ops/organizations').query({ q: 'té de' })).body;
    expect(list.total).toBe(1);
    expect(list.organizations[0]).toMatchObject({
      id: trial.organizationId,
      segment: 'trial',
      usage: { branches: 1, devices: 1 },
    });

    const detail = (await agent.get(`/v1/ops/organizations/${paid.orgId}`)).body;
    expect(detail.segment).toBe('paid');
    expect(detail.sales30dCents).toBe(6500);
    expect(detail.branches[0].usersByRole).toEqual({ owner: 1 });
    expect(detail.branches[0].devices).toHaveLength(1);
    expect(detail.salesByDay).toEqual([
      expect.objectContaining({ totalCents: 6500, tickets: 1 }),
    ]);
  });
});

describe('acciones de soporte', () => {
  it('cambia el plan, extiende la prueba y queda en la bitácora', async () => {
    const org = (await t.signup()).body;
    const agent = await signedIn();

    const plan = await agent
      .patch(`/v1/ops/organizations/${org.organizationId}/plan`)
      .send({ plan: 'max' });
    expect(plan.body.plan.plan).toBe('max');

    const before = (await t.db.organization.findUniqueOrThrow({
      where: { id: org.organizationId },
    })).currentPeriodEnd!;
    const extended = await agent
      .post(`/v1/ops/organizations/${org.organizationId}/extend-trial`)
      .send({ days: 7 });
    expect(new Date(extended.body.plan.periodEnd).getTime() - before.getTime()).toBe(
      7 * 86_400_000,
    );

    const code = await agent.post(`/v1/ops/branches/${org.branch.id}/pairing-codes`).send({});
    expect(code.body.code).toMatch(/^[A-Z2-9]{8}$/);

    const revoke = await agent.post(`/v1/ops/devices/${org.deviceId}/revoke`).send({});
    expect(revoke.body.revokedAt).toBeTruthy();

    const audit = (await agent.get('/v1/ops/audit')).body.entries.map(
      (e: { action: string }) => e.action,
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        'login',
        'plan_changed',
        'trial_extended',
        'pairing_code',
        'device_revoked',
      ]),
    );
    const detail = (await agent.get(`/v1/ops/organizations/${org.organizationId}`)).body;
    expect(detail.audit.map((a: { action: string }) => a.action)).toContain('plan_changed');
  });

  it('reconstruye proyecciones y promueve admins', async () => {
    const d = await t.pairedDevice();
    await t.push(d.token, [
      userCreated('admin'),
      envelope('category.upserted', 'category', 'c1', { id: 'c1', name: 'Tés', version: 1 }),
    ]);
    const agent = await signedIn();
    const rebuilt = await agent.post(`/v1/ops/branches/${d.branchId}/rebuild-projections`).send({});
    expect(rebuilt.body.events).toBe(2);
    const promoted = await agent.post(`/v1/ops/organizations/${d.orgId}/promote-admins`).send({});
    expect(promoted.body).toEqual({ promoted: 1 });
  });
});
