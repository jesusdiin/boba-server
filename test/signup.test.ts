import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { PairingThrottle } from '../src/routes/devices.js';
import { ADMIN_KEY, setupTestApp, userCreated } from './helpers.js';

const t = setupTestApp();

describe('registro de negocios (POST /v1/signup)', () => {
  it('crea organización, sucursal y un dispositivo con token que sincroniza', async () => {
    const res = await t.signup({ organizationName: 'Té de Ana', branchName: 'Centro' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      deviceId: expect.any(String),
      token: expect.any(String),
      organizationId: expect.any(String),
      branch: { name: 'Centro', timezoneId: 'America/Mexico_City', currencyCode: 'MXN' },
    });

    const pushed = await t.push(res.body.token, [userCreated('admin')]);
    expect(pushed.body.accepted).toHaveLength(1);
    const pulled = await t.pull(res.body.token);
    expect(pulled.body.events).toHaveLength(1);

    const org = await t.db.organization.findUnique({
      where: { id: res.body.organizationId },
    });
    expect(org?.name).toBe('Té de Ana');
  });

  it('dos negocios quedan aislados', async () => {
    const a = (await t.signup()).body;
    const b = (await t.signup()).body;
    expect(a.organizationId).not.toBe(b.organizationId);
    await t.push(a.token, [userCreated('admin')]);
    expect((await t.pull(b.token)).body.events).toHaveLength(0);
  });

  it('valida los nombres', async () => {
    const res = await t.signup({ organizationName: '  ' });
    expect(res.status).toBe(400);
  });

  it('frena registros en masa por IP', async () => {
    const app = createApp({
      db: t.db,
      adminApiKey: ADMIN_KEY,
      logger: pino({ level: 'silent' }),
      signupThrottle: new PairingThrottle(2),
    });
    const body = { organizationName: 'X', branchName: 'Y', deviceName: 'Z' };
    expect((await request(app).post('/v1/signup').send(body)).status).toBe(201);
    expect((await request(app).post('/v1/signup').send(body)).status).toBe(201);
    const third = await request(app).post('/v1/signup').send(body);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('too_many_attempts');
  });

  it('se puede cerrar con SIGNUP_ENABLED=false', async () => {
    const app = createApp({
      db: t.db,
      adminApiKey: ADMIN_KEY,
      logger: pino({ level: 'silent' }),
      signupEnabled: false,
    });
    const res = await request(app)
      .post('/v1/signup')
      .send({ organizationName: 'X', branchName: 'Y', deviceName: 'Z' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('signup_disabled');
  });
});
