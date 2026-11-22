import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { orderCreated, sale, setupTestApp, shiftOpened, userCreated } from './helpers.js';

const t = setupTestApp();

/// Sucursal con un admin y un pedido cobrado dos veces (desde dos equipos).
async function doubleCharge() {
  const a = await t.pairedDevice();
  const b = await t.pairAnother(a.branchId);
  const admin = userCreated('admin');
  const cashier = userCreated('cashier');
  const order = randomUUID();
  const shift = randomUUID();
  await t.push(a.token, [admin, cashier, shiftOpened(shift), orderCreated(order)]);
  await t.push(a.token, [sale(shift, { orderId: order })]);
  await t.push(b.token, [sale(shift, { orderId: order })]);
  return { ...a, admin: admin.aggregateId, cashier: cashier.aggregateId, order };
}

const get = (token: string, user: string, all = false) =>
  request(t.app)
    .get(`/v1/branch/conflicts${all ? '?all=1' : ''}`)
    .set('authorization', `Bearer ${token}`)
    .set('x-boba-user', user);

const review = (token: string, user: string, id: string) =>
  request(t.app)
    .post(`/v1/branch/conflicts/${id}/review`)
    .set('authorization', `Bearer ${token}`)
    .set('x-boba-user', user)
    .send({});

describe('conflictos de la sucursal desde la app', () => {
  it('el admin los ve, los marca revisados y quedan en el historial', async () => {
    const s = await doubleCharge();
    const res = await get(s.token, s.admin);
    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(1);
    const [c] = res.body.conflicts;
    expect(c).toMatchObject({
      kind: 'order_double_charge',
      details: { orderId: s.order },
      reviewedAt: null,
    });

    const done = await review(s.token, s.admin, c.id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id: c.id, reviewedByUserId: s.admin });

    const after = await get(s.token, s.admin);
    expect(after.body).toEqual({ conflicts: [], pending: 0 });
    const history = await get(s.token, s.admin, true);
    expect(history.body.conflicts[0]).toMatchObject({ id: c.id, reviewedByUserId: s.admin });

    // Revisarlo otra vez conserva la primera revisión.
    const again = await review(s.token, s.admin, c.id);
    expect(again.body.reviewedAt).toBe(done.body.reviewedAt);
  });

  it('un cajero no los ve; otra sucursal no los revisa', async () => {
    const s = await doubleCharge();
    expect((await get(s.token, s.cashier)).status).toBe(403);

    const id = (await t.db.syncConflict.findFirstOrThrow()).id;
    const other = await t.pairedDevice();
    const otherAdmin = userCreated('admin');
    await t.push(other.token, [otherAdmin]);
    expect((await review(other.token, otherAdmin.aggregateId, id)).status).toBe(404);
    expect((await get(other.token, otherAdmin.aggregateId)).body.pending).toBe(0);
    expect((await review(s.token, s.admin, 'no-es-uuid')).status).toBe(404);
  });
});
