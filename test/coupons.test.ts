import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { PANEL_ORIGIN, setupTestApp, userCreated } from './helpers.js';

const t = setupTestApp();
const DAY = 86_400_000;

/// Panel con sesión.
async function panel() {
  const { password } = (
    await t.admin().post('/operators', { email: 'ops@boba.test', name: 'Ops' })
  ).body;
  const agent = request.agent(t.app);
  await agent.post('/v1/ops/login').set('origin', PANEL_ORIGIN).send({
    email: 'ops@boba.test',
    password,
  });
  return agent;
}

async function createCoupons(body: Record<string, unknown>) {
  const agent = await panel();
  const res = await agent.post('/v1/ops/coupons').send(body);
  expect(res.status).toBe(201);
  return { agent, coupons: res.body.coupons as { id: string; code: string }[] };
}

/// Negocio recién registrado (prueba Pro de 14 días) con su Dueño y un cajero.
async function business() {
  const s = (await t.signup()).body as { token: string; organizationId: string };
  const owner = userCreated('owner');
  const cashier = userCreated('cashier');
  await t.push(s.token, [owner, cashier]);
  return { ...s, owner: owner.aggregateId, cashier: cashier.aggregateId };
}

const redeem = (token: string, user: string, code: string) =>
  request(t.app)
    .post('/v1/coupons/redeem')
    .set('authorization', `Bearer ${token}`)
    .set('x-boba-user', user)
    .send({ code });

const orgOf = (id: string) => t.db.organization.findUniqueOrThrow({ where: { id } });

describe('canjear un cupón', () => {
  it('Pro por 30 días en prueba: se suma al fin de la prueba', async () => {
    const { coupons } = await createCoupons({ plan: 'pro', durationDays: 30 });
    const b = await business();
    const trialEnd = (await orgOf(b.organizationId)).currentPeriodEnd!;

    const res = await redeem(b.token, b.owner, ` ${coupons[0]!.code.toLowerCase()} `);
    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({
      plan: 'pro',
      status: 'active',
      state: 'active',
    });
    const org = await orgOf(b.organizationId);
    expect(org.currentPeriodEnd!.getTime() - trialEnd.getTime()).toBe(30 * DAY);
    expect(org.billingSource).toBe('manual');
    const redemption = await t.db.couponRedemption.findFirstOrThrow();
    expect(redemption.previousPlan).toMatchObject({ plan: 'pro', status: 'trialing' });
  });

  it('Max sin vencimiento y con límites extra; cuenta desde ahora', async () => {
    const { coupons } = await createCoupons({
      plan: 'max',
      durationDays: null,
      limitOverrides: { devices: 20 },
    });
    const b = await business();
    const res = await redeem(b.token, b.owner, coupons[0]!.code);
    expect(res.body.plan).toMatchObject({
      plan: 'max',
      periodEnd: null,
      limits: { branches: 3, devices: 20 },
    });
  });

  it('rechazos: no existe, deshabilitado, vencido, agotado, ya usado', async () => {
    const { agent, coupons } = await createCoupons({
      plan: 'pro',
      durationDays: 30,
      maxRedemptions: 1,
      count: 3,
    });
    const [a, disabled, expired] = coupons as [
      { id: string; code: string },
      { id: string; code: string },
      { id: string; code: string },
    ];
    const b = await business();
    expect((await redeem(b.token, b.owner, 'NO-EXISTE')).body.error.code).toBe(
      'invalid_coupon',
    );

    await agent.patch(`/v1/ops/coupons/${disabled.id}`).send({ disabled: true });
    expect((await redeem(b.token, b.owner, disabled.code)).body.error.code).toBe(
      'invalid_coupon',
    );

    await t.db.coupon.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await redeem(b.token, b.owner, expired.code)).status).toBe(410);

    expect((await redeem(b.token, b.owner, a.code)).status).toBe(200);
    const other = await business();
    expect((await redeem(other.token, other.owner, a.code)).body.error.code).toBe(
      'coupon_exhausted',
    );
  });

  it('el mismo negocio no lo usa dos veces; canjes simultáneos respetan el máximo', async () => {
    const { coupons } = await createCoupons({
      plan: 'pro',
      durationDays: 30,
      maxRedemptions: 2,
    });
    const code = coupons[0]!.code;
    const b = await business();
    await redeem(b.token, b.owner, code);
    expect((await redeem(b.token, b.owner, code)).body.error.code).toBe(
      'coupon_already_used',
    );

    const [x, y] = [await business(), await business()];
    const results = await Promise.all([
      redeem(x.token, x.owner, code),
      redeem(y.token, y.owner, code),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await t.db.coupon.findFirstOrThrow()).redemptionCount).toBe(2);
  });

  it('suscripción de la tienda, plan mayor y cortesía ilimitada', async () => {
    const { coupons } = await createCoupons({ plan: 'pro', durationDays: 30, count: 3 });
    const [c1, c2, c3] = coupons.map((c) => c.code) as [string, string, string];

    const store = await business();
    await t.db.organization.update({
      where: { id: store.organizationId },
      data: { billingSource: 'store', subscriptionStatus: 'active' },
    });
    expect((await redeem(store.token, store.owner, c1)).body.error.code).toBe(
      'store_subscription',
    );

    const max = await business();
    await t.db.organization.update({
      where: { id: max.organizationId },
      data: { plan: 'max', subscriptionStatus: 'active' },
    });
    expect((await redeem(max.token, max.owner, c2)).body.error.code).toBe('higher_plan');

    const free = await business();
    await t.db.organization.update({
      where: { id: free.organizationId },
      data: { subscriptionStatus: 'active', currentPeriodEnd: null },
    });
    expect((await redeem(free.token, free.owner, c3)).body.error.code).toBe(
      'already_unlimited',
    );
  });

  it('solo el Dueño; un plan vencido sí puede canjear', async () => {
    const { coupons } = await createCoupons({ plan: 'pro', durationDays: 30 });
    const b = await business();
    expect((await redeem(b.token, b.cashier, coupons[0]!.code)).status).toBe(403);

    await t.db.organization.update({
      where: { id: b.organizationId },
      data: { currentPeriodEnd: new Date(Date.now() - 30 * DAY) },
    });
    const res = await redeem(b.token, b.owner, coupons[0]!.code);
    expect(res.status).toBe(200);
    expect(res.body.plan.state).toBe('active');
  });
});

describe('freno de intentos', () => {
  const limited = setupTestApp({ couponFailures: 2 });

  it('códigos inexistentes repetidos → 429', async () => {
    const s = (await limited.signup()).body as { token: string };
    const owner = userCreated('owner');
    await limited.push(s.token, [owner]);
    const send = () =>
      request(limited.app)
        .post('/v1/coupons/redeem')
        .set('authorization', `Bearer ${s.token}`)
        .set('x-boba-user', owner.aggregateId)
        .send({ code: 'NADA-1234' });
    expect((await send()).status).toBe(404);
    expect((await send()).status).toBe(404);
    expect((await send()).status).toBe(429);
  });
});

describe('alta con cupón', () => {
  it('válido: arranca con su plan; inválido: no se crea nada', async () => {
    const { coupons } = await createCoupons({ plan: 'max', durationDays: null });
    const ok = await t.signup({ couponCode: coupons[0]!.code });
    expect(ok.status).toBe(201);
    const org = await orgOf(ok.body.organizationId);
    expect(org).toMatchObject({
      plan: 'max',
      subscriptionStatus: 'active',
      currentPeriodEnd: null,
    });

    const before = await t.db.organization.count();
    const bad = await t.signup({ couponCode: 'NO-EXISTE' });
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe('invalid_coupon');
    expect(await t.db.organization.count()).toBe(before);
  });
});

describe('panel: cupones', () => {
  it('crea uno propio, un lote, busca, ve canjes y deshabilita', async () => {
    const agent = await panel();
    const own = await agent.post('/v1/ops/coupons').send({
      plan: 'pro',
      durationDays: 90,
      maxRedemptions: null,
      code: 'cafe 2026',
      note: 'Feria del café',
    });
    expect(own.body.coupons[0]).toMatchObject({ code: 'CAFE2026', status: 'active' });
    const again = await agent.post('/v1/ops/coupons').send({
      plan: 'pro',
      durationDays: 90,
      code: 'CAFE2026',
    });
    expect(again.status).toBe(409);

    const batch = await agent.post('/v1/ops/coupons').send({
      plan: 'max',
      durationDays: 30,
      count: 5,
    });
    const codes = batch.body.coupons.map((c: { code: string }) => c.code);
    expect(new Set(codes).size).toBe(5);
    expect(codes[0]).toMatch(/^BOBA-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(
      new Set(batch.body.coupons.map((c: { batchId: string }) => c.batchId)).size,
    ).toBe(1);

    const b = await business();
    await redeem(b.token, b.owner, 'CAFE2026');
    const found = (await agent.get('/v1/ops/coupons').query({ q: 'feria' })).body.coupons;
    expect(found).toHaveLength(1);
    const detail = (await agent.get(`/v1/ops/coupons/${found[0].id}`)).body;
    expect(detail.redemptions[0].organization.id).toBe(b.organizationId);
    const org = (await agent.get(`/v1/ops/organizations/${b.organizationId}`)).body;
    expect(org.coupons[0]).toMatchObject({ code: 'CAFE2026', plan: 'pro' });

    await agent.patch(`/v1/ops/coupons/${found[0].id}`).send({ disabled: true });
    const disabled = (await agent.get('/v1/ops/coupons').query({ status: 'disabled' }))
      .body;
    expect(disabled.coupons.map((c: { code: string }) => c.code)).toEqual(['CAFE2026']);

    const audit = (await agent.get('/v1/ops/audit')).body.entries.map(
      (e: { action: string }) => e.action,
    );
    expect(audit).toEqual(expect.arrayContaining(['coupon_created', 'coupon_disabled']));
  });
});

describe('deshabilitar y revocar', () => {
  it('sin revocar, el negocio conserva el plan', async () => {
    const { agent, coupons } = await createCoupons({ plan: 'max', durationDays: null });
    const b = await business();
    await redeem(b.token, b.owner, coupons[0]!.code);
    const res = await agent
      .patch(`/v1/ops/coupons/${coupons[0]!.id}`)
      .send({ disabled: true });
    expect(res.body).toMatchObject({ status: 'disabled', revoked: [], skipped: [] });
    expect(await orgOf(b.organizationId)).toMatchObject({
      plan: 'max',
      currentPeriodEnd: null,
    });
  });

  it('revocar devuelve su plan anterior; si ya venció, queda vencido', async () => {
    const { agent, coupons } = await createCoupons({
      plan: 'max',
      durationDays: null,
      maxRedemptions: null,
    });
    const code = coupons[0]!.code;
    const fresh = await business();
    const trialEnd = (await orgOf(fresh.organizationId)).currentPeriodEnd!;
    await redeem(fresh.token, fresh.owner, code);

    const old = await business();
    await t.db.organization.update({
      where: { id: old.organizationId },
      data: { currentPeriodEnd: new Date(Date.now() - 30 * DAY) },
    });
    await redeem(old.token, old.owner, code);

    // Este después compró en la tienda: no se toca.
    const bought = await business();
    await redeem(bought.token, bought.owner, code);
    await t.db.organization.update({
      where: { id: bought.organizationId },
      data: { billingSource: 'store' },
    });

    const detail = (await agent.get(`/v1/ops/coupons/${coupons[0]!.id}`)).body;
    expect(
      detail.redemptions.filter((r: { current: boolean }) => r.current),
    ).toHaveLength(2);

    const res = await agent
      .patch(`/v1/ops/coupons/${coupons[0]!.id}`)
      .send({ disabled: true, revoke: true });
    expect(res.body.revoked.sort()).toEqual(
      [fresh.organizationId, old.organizationId].sort(),
    );
    expect(res.body.skipped).toEqual([bought.organizationId]);

    expect(await orgOf(fresh.organizationId)).toMatchObject({
      plan: 'pro',
      subscriptionStatus: 'trialing',
      currentPeriodEnd: trialEnd,
      billingSource: 'manual',
    });
    // La prueba vencida vuelve: el negocio queda pausado.
    const lapsed = await request(t.app)
      .get('/v1/sync/pull')
      .set('authorization', `Bearer ${old.token}`);
    expect(lapsed.status).toBe(402);
    expect((await orgOf(bought.organizationId)).plan).toBe('max');

    // No se revoca dos veces; la bitácora lo registra por negocio.
    const again = await agent
      .patch(`/v1/ops/coupons/${coupons[0]!.id}`)
      .send({ disabled: true, revoke: true });
    expect(again.body.revoked).toEqual([]);
    const after = (await agent.get(`/v1/ops/coupons/${coupons[0]!.id}`)).body;
    expect(
      after.redemptions.filter((r: { revokedAt: string | null }) => r.revokedAt),
    ).toHaveLength(2);
    const org = (await agent.get(`/v1/ops/organizations/${fresh.organizationId}`)).body;
    expect(org.audit.map((a: { action: string }) => a.action)).toContain(
      'coupon_revoked',
    );
  });
});
