import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/tokens.js';
import { setupTestApp } from './helpers.js';

const t = setupTestApp();

describe('emparejamiento', () => {
  it('admin → código → pair → token que autentica', async () => {
    const org = (await t.admin().post('/organizations', { name: 'Boba & Co.' })).body;
    const branch = (
      await t.admin().post(`/organizations/${org.id}/branches`, {
        name: 'Centro',
        timezoneId: 'America/Monterrey',
      })
    ).body;
    const codeRes = await t.admin().post(`/branches/${branch.id}/pairing-codes`);
    expect(codeRes.status).toBe(201);
    expect(codeRes.body.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

    const paired = await request(t.app)
      .post('/v1/devices/pair')
      .send({ code: codeRes.body.code.toLowerCase(), deviceName: 'iPad caja' });
    expect(paired.status).toBe(201);
    expect(paired.body.branch).toMatchObject({
      id: branch.id,
      timezoneId: 'America/Monterrey',
    });

    const device = await t.db.device.findUniqueOrThrow({
      where: { id: paired.body.deviceId },
    });
    expect(device.tokenHash).toBe(sha256(paired.body.token));
    expect(device.tokenHash).not.toContain(paired.body.token);

    const pull = await t.pull(paired.body.token);
    expect(pull.status).toBe(200);
  });

  it('un código usado o vencido no se puede canjear', async () => {
    const { branchId } = await t.pairedDevice();
    const { code } = (await t.admin().post(`/branches/${branchId}/pairing-codes`)).body;

    const first = await request(t.app)
      .post('/v1/devices/pair')
      .send({ code, deviceName: 'A' });
    expect(first.status).toBe(201);
    const again = await request(t.app)
      .post('/v1/devices/pair')
      .send({ code, deviceName: 'B' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('invalid_code');

    const expired = (await t.admin().post(`/branches/${branchId}/pairing-codes`)).body;
    await t.db.devicePairingCode.updateMany({
      where: { usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const late = await request(t.app)
      .post('/v1/devices/pair')
      .send({ code: expired.code, deviceName: 'C' });
    expect(late.status).toBe(400);
  });

  it('los endpoints admin exigen la llave', async () => {
    const res = await request(t.app).post('/v1/admin/organizations').send({ name: 'X' });
    expect(res.status).toBe(401);
    const wrong = await request(t.app)
      .post('/v1/admin/organizations')
      .set('x-admin-key', 'otra-llave')
      .send({ name: 'X' });
    expect(wrong.status).toBe(401);
  });
});
