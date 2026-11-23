import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { FakePushSender } from '../src/push/sender.js';
import { PANEL_ORIGIN, setupTestApp } from './helpers.js';

const fcm = (n: number) => `fcm-token-${n}-${'x'.repeat(20)}`;

const register = (
  app: Parameters<typeof request>[0],
  token: string,
  deviceToken?: string,
) => {
  const req = request(app).put('/v1/push/token');
  if (deviceToken) req.set('authorization', `Bearer ${deviceToken}`);
  return req.send({ token, platform: 'android', appVersion: '1.2.0+7', locale: 'es-MX' });
};

/// Sesión del panel (cookie en el agente).
async function signedIn(t: ReturnType<typeof setupTestApp>) {
  const op = await t
    .admin()
    .post('/operators', { email: 'ops@boba.test', name: 'Jesús' });
  const agent = request.agent(t.app);
  await agent
    .post('/v1/ops/login')
    .set('origin', PANEL_ORIGIN)
    .send({ email: 'ops@boba.test', password: op.body.password });
  return agent;
}

describe('registro de instalaciones (/v1/push/token)', () => {
  const t = setupTestApp();

  it('sin token de equipo queda anónima; con token, ligada a su negocio', async () => {
    const res = await register(t.app, fcm(1));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: false });

    const d = await t.pairedDevice();
    const linked = await register(t.app, fcm(2), d.token);
    expect(linked.body).toEqual({ linked: true });

    const rows = await t.db.pushToken.findMany({ orderBy: { token: 'asc' } });
    expect(rows.map((r) => [r.organizationId, r.deviceId])).toEqual([
      [null, null],
      [d.orgId, d.deviceId],
    ]);
    expect(rows[0]!.appVersion).toBe('1.2.0+7');
  });

  it('registrar de nuevo actualiza (al emparejar se liga; un token inválido no)', async () => {
    const d = await t.pairedDevice();
    await register(t.app, fcm(1));
    await register(t.app, fcm(1), d.token);
    expect(
      (await t.db.pushToken.findUniqueOrThrow({ where: { token: fcm(1) } }))
        .organizationId,
    ).toBe(d.orgId);
    // Equipo revocado o token falso: queda anónima, no truena.
    const again = await register(t.app, fcm(1), 'no-es-un-token');
    expect(again.body).toEqual({ linked: false });
    expect(await t.db.pushToken.count()).toBe(1);
  });

  it('DELETE la borra; cuerpo inválido → 400', async () => {
    await register(t.app, fcm(1));
    const del = await request(t.app)
      .delete('/v1/push/token')
      .send({ token: fcm(1) });
    expect(del.status).toBe(204);
    expect(await t.db.pushToken.count()).toBe(0);
    const bad = await request(t.app)
      .put('/v1/push/token')
      .send({ token: 'x', platform: 'windows' });
    expect(bad.status).toBe(400);
  });
});

describe('freno del registro', () => {
  const t = setupTestApp({ pushRegistrations: 2 });

  it('frena por IP', async () => {
    expect((await register(t.app, fcm(1))).status).toBe(200);
    expect((await register(t.app, fcm(2))).status).toBe(200);
    expect((await register(t.app, fcm(3))).status).toBe(429);
  });
});

describe('avisos desde el panel (/v1/ops/push)', () => {
  const sender = new FakePushSender(new Set([fcm(3)]));
  const t = setupTestApp({ pushSender: sender });

  it('manda a todas, borra los tokens caducos y queda en el historial', async () => {
    sender.sends.length = 0;
    const d = await t.pairedDevice();
    await register(t.app, fcm(1));
    await register(t.app, fcm(2), d.token);
    await register(t.app, fcm(3));
    const agent = await signedIn(t);

    const stats = await agent.get('/v1/ops/push/stats');
    expect(stats.body).toMatchObject({
      configured: true,
      installs: 3,
      linked: 1,
      anonymous: 2,
      seenLast14Days: 3,
    });

    const res = await agent
      .post('/v1/ops/push/campaigns')
      .send({ title: 'Versión nueva', body: 'Ábrela y pruébala', audience: 'all' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ targeted: 3, sent: 2, failed: 1, removed: 1 });
    expect(sender.sends[0]!.tokens.sort()).toEqual([fcm(1), fcm(2), fcm(3)].sort());
    expect(sender.sends[0]!.message).toEqual({
      title: 'Versión nueva',
      body: 'Ábrela y pruébala',
    });
    expect(await t.db.pushToken.count()).toBe(2);

    const list = await agent.get('/v1/ops/push/campaigns');
    expect(list.body.campaigns).toHaveLength(1);
    expect(list.body.campaigns[0]).toMatchObject({
      title: 'Versión nueva',
      operatorName: 'Jesús',
      organizationName: null,
    });
    const audit = await t.db.operatorAudit.findMany({ where: { action: 'push_sent' } });
    expect(audit).toHaveLength(1);
  });

  it('a un negocio: solo sus instalaciones', async () => {
    sender.sends.length = 0;
    const a = await t.pairedDevice();
    const b = await t.pairedDevice();
    await register(t.app, fcm(1), a.token);
    await register(t.app, fcm(2), b.token);
    await register(t.app, fcm(4));
    const agent = await signedIn(t);

    const res = await agent.post('/v1/ops/push/campaigns').send({
      title: 'Hola',
      body: 'Solo para ti',
      audience: 'organization',
      organizationId: a.orgId,
    });
    expect(res.status).toBe(201);
    expect(sender.sends[0]!.tokens).toEqual([fcm(1)]);
    const list = await agent.get('/v1/ops/push/campaigns');
    expect(list.body.campaigns[0].organizationName).toBeTruthy();
  });

  it('valida: negocio requerido, textos largos, nadie a quien mandar', async () => {
    const agent = await signedIn(t);
    const noOrg = await agent
      .post('/v1/ops/push/campaigns')
      .send({ title: 'a', body: 'b', audience: 'organization' });
    expect(noOrg.status).toBe(400);
    const long = await agent
      .post('/v1/ops/push/campaigns')
      .send({ title: 'x'.repeat(66), body: 'b', audience: 'all' });
    expect(long.status).toBe(400);
    const nobody = await agent
      .post('/v1/ops/push/campaigns')
      .send({ title: 'a', body: 'b', audience: 'all' });
    expect(nobody.status).toBe(409);
  });

  it('sin sesión del panel → 401', async () => {
    const res = await request(t.app)
      .post('/v1/ops/push/campaigns')
      .send({ title: 'a', body: 'b', audience: 'all' });
    expect(res.status).toBe(401);
  });
});

describe('sin Firebase configurado', () => {
  const t = setupTestApp({ pushSender: null });

  it('las instalaciones se registran, pero enviar → 503', async () => {
    await register(t.app, fcm(1));
    const agent = await signedIn(t);
    expect((await agent.get('/v1/ops/push/stats')).body.configured).toBe(false);
    const res = await agent
      .post('/v1/ops/push/campaigns')
      .send({ title: 'a', body: 'b', audience: 'all' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('push_not_configured');
  });
});
