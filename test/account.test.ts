import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { maskEmail } from '../src/routes/account.js';
import { setupTestApp, userCreated } from './helpers.js';

const t = setupTestApp();

/// Negocio con un Dueño, un admin y un cajero (subidos).
async function business() {
  const d = await t.pairedDevice();
  const owner = userCreated('owner');
  const admin = userCreated('admin');
  const cashier = userCreated('cashier');
  await t.push(d.token, [owner, admin, cashier]);
  return {
    ...d,
    owner: owner.aggregateId,
    admin: admin.aggregateId,
    cashier: cashier.aggregateId,
  };
}

const call = (token: string, method: 'get' | 'post', path: string, user?: string) => {
  const r = request(t.app)[method](`/v1/account${path}`).set('authorization', `Bearer ${token}`);
  return user ? r.set('x-boba-user', user) : r;
};

async function link(token: string, user: string, email: string) {
  const start = await call(token, 'post', '/email/start', user).send({ email });
  expect(start.status).toBe(202);
  const code = t.mailer.lastCode(email.toLowerCase())!;
  return call(token, 'post', '/email/verify', user).send({ email, code });
}

describe('correo del Dueño', () => {
  it('envía un código y al verificarlo liga el correo', async () => {
    const b = await business();
    expect((await call(b.token, 'get', '/email', b.owner)).body).toEqual({ account: null });

    const res = await link(b.token, b.owner, 'Jesus@Boba.test');
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ email: 'jesus@boba.test' });
    const sent = t.mailer.sent.at(-1)!;
    expect(sent.subject).toMatch(/Tu código de Boba POS: \d{6}/);
    expect(sent.text).toMatch(/verificar tu correo/);

    expect((await call(b.token, 'get', '/email', b.owner)).body.account.email).toBe(
      'jesus@boba.test',
    );
  });

  it('cambiar de correo reemplaza el anterior; el código es de un solo uso', async () => {
    const b = await business();
    await link(b.token, b.owner, 'a@boba.test');
    await link(b.token, b.owner, 'b@boba.test');
    expect(await t.db.ownerAccount.findMany({ select: { email: true } })).toEqual([
      { email: 'b@boba.test' },
    ]);
    const code = t.mailer.lastCode('b@boba.test')!;
    const again = await call(b.token, 'post', '/email/verify', b.owner).send({
      email: 'b@boba.test',
      code,
    });
    expect(again.body.error.code).toBe('invalid_code');
  });

  it('5 códigos incorrectos lo invalidan; uno vencido falla', async () => {
    const b = await business();
    await call(b.token, 'post', '/email/start', b.owner).send({ email: 'x@boba.test' });
    const good = t.mailer.lastCode('x@boba.test')!;
    const wrong = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await call(b.token, 'post', '/email/verify', b.owner).send({
        email: 'x@boba.test',
        code: wrong,
      });
      expect(r.body.error.code).toBe('invalid_code');
    }
    const locked = await call(b.token, 'post', '/email/verify', b.owner).send({
      email: 'x@boba.test',
      code: good,
    });
    expect(locked.status).toBe(429);

    await call(b.token, 'post', '/email/start', b.owner).send({ email: 'x@boba.test' });
    await t.db.emailCode.updateMany({
      where: { consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await call(b.token, 'post', '/email/verify', b.owner).send({
      email: 'x@boba.test',
      code: t.mailer.lastCode('x@boba.test'),
    });
    expect(expired.body.error.code).toBe('code_expired');
  });

  it('solo un Dueño; un correo de otro negocio → 409', async () => {
    const b = await business();
    for (const user of [b.admin, b.cashier]) {
      const r = await call(b.token, 'post', '/email/start', user).send({ email: 'a@boba.test' });
      expect(r.status).toBe(403);
    }
    await link(b.token, b.owner, 'a@boba.test');

    const other = await business();
    const taken = await call(other.token, 'post', '/email/start', other.owner).send({
      email: 'A@boba.test',
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('email_taken');
    const bad = await call(other.token, 'post', '/email/start', other.owner).send({
      email: 'no-es-correo',
    });
    expect(bad.status).toBe(400);
  });
});

describe('cambiar el PIN olvidado del Dueño', () => {
  it('sin correo → no_account; con correo llega el código y se verifica', async () => {
    const b = await business();
    const none = await call(b.token, 'post', '/pin-reset/start').send({ userId: b.owner });
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('no_account');

    await link(b.token, b.owner, 'jesus@boba.test');
    const start = await call(b.token, 'post', '/pin-reset/start').send({ userId: b.owner });
    expect(start.status).toBe(202);
    expect(start.body).toEqual({ maskedEmail: 'j•••@boba.test' });
    expect(t.mailer.sent.at(-1)!.text).toMatch(/cambiar el PIN/);

    const code = t.mailer.lastCode('jesus@boba.test')!;
    const ok = await call(b.token, 'post', '/pin-reset/verify').send({ userId: b.owner, code });
    expect(ok.body).toEqual({ ok: true });
    const reused = await call(b.token, 'post', '/pin-reset/verify').send({
      userId: b.owner,
      code,
    });
    expect(reused.body.error.code).toBe('invalid_code');
  });

  it('el código no sirve desde otro negocio ni para un no Dueño', async () => {
    const b = await business();
    await link(b.token, b.owner, 'jesus@boba.test');
    await call(b.token, 'post', '/pin-reset/start').send({ userId: b.owner });
    const code = t.mailer.lastCode('jesus@boba.test')!;

    const other = await t.pairedDevice();
    const r = await call(other.token, 'post', '/pin-reset/verify').send({ userId: b.owner, code });
    expect(r.status).toBe(404);

    const cashier = await call(b.token, 'post', '/pin-reset/start').send({ userId: b.cashier });
    expect(cashier.status).toBe(404);
  });

  it('pedir otro código anula los anteriores', async () => {
    const b = await business();
    await link(b.token, b.owner, 'jesus@boba.test');
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (await call(b.token, 'post', '/pin-reset/start').send({ userId: b.owner })).status,
      );
    }
    expect(statuses).toEqual([202, 202, 202]);
    expect(await t.db.emailCode.count({ where: { consumedAt: null } })).toBe(1);
  });
});

describe('maskEmail', () => {
  it('deja la primera letra y el dominio', () => {
    expect(maskEmail('jesus@gmail.com')).toBe('j•••@gmail.com');
  });
});

describe('freno de envíos', () => {
  const limited = setupTestApp({ accountSends: 2 });

  it('más de N códigos seguidos para el mismo usuario → 429', async () => {
    const d = await limited.pairedDevice();
    const owner = userCreated('owner');
    await limited.push(d.token, [owner]);
    const send = () =>
      request(limited.app)
        .post('/v1/account/email/start')
        .set('authorization', `Bearer ${d.token}`)
        .set('x-boba-user', owner.aggregateId)
        .send({ email: 'a@boba.test' });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(429);
  });
});

describe('panel del operador', () => {
  it('muestra los correos de los Dueños y busca por correo', async () => {
    const b = await business();
    await link(b.token, b.owner, 'jesus@boba.test');
    const { password } = (await t.admin().post('/operators', { email: 'ops@boba.test', name: 'Ops' })).body;
    const agent = request.agent(t.app);
    await agent.post('/v1/ops/login').send({ email: 'ops@boba.test', password });

    const found = (await agent.get('/v1/ops/organizations').query({ q: 'jesus@boba' })).body;
    expect(found.organizations.map((o: { id: string }) => o.id)).toEqual([b.orgId]);
    const detail = (await agent.get(`/v1/ops/organizations/${b.orgId}`)).body;
    expect(detail.ownerEmails).toEqual([
      expect.objectContaining({ email: 'jesus@boba.test' }),
    ]);
  });
});
