import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { envelope, setupTestApp, userCreated } from './helpers.js';

const t = setupTestApp();

const details = (branchId: string, setAtUtc: string, extra: Record<string, unknown> = {}) =>
  envelope('branch.details_set', 'branch', branchId, {
    businessName: 'Perlas & Té',
    branchName: 'Centro',
    address: 'Av. Juárez 10',
    phone: '+52 55 1234 5678',
    whatsapp: null,
    instagram: 'perlas.te',
    setAtUtc,
    userId: null,
    ...extra,
  });

describe('branch.details_set (negocio y sucursal)', () => {
  it('actualiza la empresa y la sucursal; el equipo nuevo recibe el nombre', async () => {
    const a = (await t.signup()).body as { token: string; branch: { id: string } };
    const admin = userCreated('admin');
    await t.push(a.token, [admin]);
    const res = await t.push(a.token, [
      details(a.branch.id, '2026-11-06T15:00:00.000Z', { userId: admin.aggregateId }),
      // Uno viejo que llega después no pisa al nuevo.
      details(a.branch.id, '2026-11-06T14:00:00.000Z', {
        userId: admin.aggregateId,
        businessName: 'Viejo',
      }),
    ]);
    expect(res.body.accepted).toHaveLength(2);

    const branch = await t.db.branch.findUnique({
      where: { id: a.branch.id },
      include: { organization: true },
    });
    expect(branch).toMatchObject({
      name: 'Centro',
      address: 'Av. Juárez 10',
      instagram: 'perlas.te',
      organization: { name: 'Perlas & Té' },
    });

    const { code } = (await t.branch(a.token, admin.aggregateId).post('/pairing-codes')).body;
    const joined = (
      await request(t.app).post('/v1/devices/pair').send({ code, deviceName: 'iPad 2' })
    ).body;
    expect(joined).toMatchObject({ organizationName: 'Perlas & Té', branch: { name: 'Centro' } });
    const snapshot = (await t.snapshot(joined.token, a.branch.id)).body;
    expect(snapshot.branchDetails).toMatchObject({ businessName: 'Perlas & Té' });
  });

  it('solo un admin y con nombres', async () => {
    const { token, branchId } = await t.pairedDevice();
    const cashier = userCreated('cashier');
    await t.push(token, [cashier]);
    const at = '2026-11-06T15:00:00.000Z';
    const denied = await t.push(token, [details(branchId, at, { userId: cashier.aggregateId })]);
    expect(denied.body.rejected[0]).toMatchObject({ code: 'forbidden' });
    const empty = await t.push(token, [details(branchId, at, { businessName: '  ' })]);
    expect(empty.body.rejected[0]).toMatchObject({ code: 'invalid_event' });
  });
});
