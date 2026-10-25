import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sale, setupTestApp, shiftOpened, userCreated } from './helpers.js';

const t = setupTestApp();

describe('árbitro: permisos por rol', () => {
  it('un cajero puede cobrar; un mesero no', async () => {
    const a = await t.pairedDevice();
    const cashier = userCreated('cashier');
    const waiter = userCreated('waiter');
    const shift = randomUUID();
    await t.push(a.token, [cashier, waiter, shiftOpened(shift)]);

    const ok = await t.push(a.token, [sale(shift, { userId: cashier.aggregateId })]);
    expect(ok.body.accepted).toHaveLength(1);
    const denied = await t.push(a.token, [sale(shift, { userId: waiter.aggregateId })]);
    expect(denied.body.rejected[0]).toMatchObject({ code: 'forbidden' });
  });

  it('un usuario desconocido o inactivo se rechaza', async () => {
    const a = await t.pairedDevice();
    const inactive = userCreated('cashier', randomUUID(), false);
    const shift = randomUUID();
    await t.push(a.token, [inactive, shiftOpened(shift)]);

    for (const userId of [randomUUID(), inactive.aggregateId]) {
      const res = await t.push(a.token, [sale(shift, { userId })]);
      expect(res.body.rejected[0]).toMatchObject({ code: 'unknown_user' });
    }
  });

  it('abrir turno exige cashShift', async () => {
    const a = await t.pairedDevice();
    const waiter = userCreated('waiter');
    await t.push(a.token, [waiter]);
    const res = await t.push(a.token, [
      shiftOpened(randomUUID(), { openedByUserId: waiter.aggregateId }),
    ]);
    expect(res.body.rejected[0]).toMatchObject({ code: 'forbidden' });
  });

  it('los usuarios de otra sucursal no cuentan', async () => {
    const a = await t.pairedDevice();
    const other = await t.pairedDevice({ orgId: a.orgId });
    const admin = userCreated('admin');
    await t.push(other.token, [admin]);
    const shift = randomUUID();
    await t.push(a.token, [shiftOpened(shift)]);

    const res = await t.push(a.token, [sale(shift, { userId: admin.aggregateId })]);
    expect(res.body.rejected[0]).toMatchObject({ code: 'unknown_user' });
  });
});
