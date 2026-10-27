import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { CLOSE_REVOKED } from '../src/realtime/branchNotifier.js';
import { envelope, setupTestApp, userCreated } from './helpers.js';

const t = setupTestApp();

/// Negocio registrado desde la app con su admin ya sincronizado.
async function businessWithAdmin() {
  const device = (await t.signup()).body as { deviceId: string; token: string };
  const admin = userCreated('admin');
  await t.push(device.token, [admin]);
  return { ...device, adminId: admin.aggregateId };
}

describe('administración de la sucursal desde la app (/v1/branch)', () => {
  it('un admin genera un código y otro dispositivo se une con él', async () => {
    const a = await businessWithAdmin();
    const res = await t.branch(a.token, a.adminId).post('/pairing-codes');
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[A-Z2-9]{8}$/);

    const joined = await request(t.app)
      .post('/v1/devices/pair')
      .send({ code: res.body.code, deviceName: 'iPad kiosco' });
    expect(joined.status).toBe(201);
    // Llega a la misma sucursal: ve lo que subió el primero.
    expect((await t.pull(joined.body.token)).body.events).toHaveLength(1);

    const list = await t.branch(a.token, a.adminId).get('/devices');
    expect(list.body.devices.map((d: { name: string }) => d.name)).toEqual([
      'iPad caja',
      'iPad kiosco',
    ]);
  });

  it('exige un admin activo de la misma sucursal', async () => {
    const a = await businessWithAdmin();
    const cashier = userCreated('cashier');
    const inactive = userCreated('admin', randomUUID(), false);
    await t.push(a.token, [cashier, inactive]);
    const other = await businessWithAdmin();

    const codeFor = (userId?: string) => t.branch(a.token, userId).post('/pairing-codes');
    expect((await codeFor(cashier.aggregateId)).body.error.code).toBe('forbidden');
    expect((await codeFor(inactive.aggregateId)).body.error.code).toBe('unknown_user');
    expect((await codeFor(other.adminId)).body.error.code).toBe('unknown_user');
    expect((await codeFor()).body.error.code).toBe('unknown_user');
    expect((await codeFor(cashier.aggregateId)).status).toBe(403);
  });

  it('un kiosco no administra la sucursal', async () => {
    const a = await businessWithAdmin();
    await t.push(a.token, [
      envelope('device.mode_changed', 'device', a.deviceId, {
        deviceId: a.deviceId,
        mode: 'kiosk',
      }),
    ]);
    const res = await t.branch(a.token, a.adminId).get('/devices');
    expect(res.body.error.code).toBe('kiosk_forbidden');
  });

  it('exige token de dispositivo', async () => {
    const res = await request(t.app).get('/v1/branch/devices');
    expect(res.status).toBe(401);
  });

  it('la lista solo muestra la propia sucursal', async () => {
    const a = await businessWithAdmin();
    await businessWithAdmin();
    const list = await t.branch(a.token, a.adminId).get('/devices');
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0].id).toBe(a.deviceId);
  });

  it('desconectar corta el socket; no aplica a otra sucursal ni a sí mismo', async () => {
    const a = await businessWithAdmin();
    const { code } = (await t.branch(a.token, a.adminId).post('/pairing-codes')).body;
    const b = (
      await request(t.app).post('/v1/devices/pair').send({ code, deviceName: 'iPad 2' })
    ).body;
    const other = await businessWithAdmin();

    const url = await t.listen();
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${b.token}` } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => ws.once('close', (c) => resolve(c)));

    const admin = t.branch(a.token, a.adminId);
    expect((await admin.post(`/devices/${other.deviceId}/revoke`)).status).toBe(404);
    const self = await admin.post(`/devices/${a.deviceId}/revoke`);
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('cannot_revoke_self');

    const revoked = await admin.post(`/devices/${b.deviceId}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).toBeTruthy();
    expect(await closed).toBe(CLOSE_REVOKED);
    expect((await t.pull(b.token)).status).toBe(401);
  });
});
