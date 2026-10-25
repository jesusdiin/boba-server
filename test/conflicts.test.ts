import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  orderCancelled,
  orderCreated,
  productUpserted,
  sale,
  setupTestApp,
  shiftClosed,
  shiftOpened,
} from './helpers.js';

const t = setupTestApp();

type Pulled = { type: string; payload: Record<string, unknown> };

async function pulledOf(token: string): Promise<Pulled[]> {
  return (await t.pull(token, { limit: 500 })).body.events;
}

describe('árbitro: turnos', () => {
  it('un segundo turno abierto se fusiona en el primero; sus ventas se re-asignan', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairAnother(a.branchId);
    const shiftA = randomUUID();
    const shiftB = randomUUID();
    expect((await t.push(a.token, [shiftOpened(shiftA)])).body.accepted).toHaveLength(1);

    const saleB = sale(shiftB);
    const res = await t.push(b.token, [shiftOpened(shiftB), saleB]);

    expect(res.body.rejected).toEqual([
      expect.objectContaining({
        code: 'shift_conflict',
        details: { winner: expect.objectContaining({ id: shiftA, status: 'open' }) },
      }),
    ]);
    expect(res.body.accepted.map((x: { eventId: string }) => x.eventId)).toEqual([
      saleB.eventId,
    ]);
    const stored = (await pulledOf(a.token)).find((e) => e.type === 'sale.created')!;
    expect((stored.payload.sale as { shiftId: string }).shiftId).toBe(shiftA);
  });

  it('el cierre del turno fusionado se descarta y queda como conflicto', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairAnother(a.branchId);
    const shiftA = randomUUID();
    const shiftB = randomUUID();
    await t.push(a.token, [shiftOpened(shiftA)]);
    await t.push(b.token, [shiftOpened(shiftB)]);

    const res = await t.push(b.token, [shiftClosed(shiftB)]);
    expect(res.body.rejected[0]).toMatchObject({
      code: 'shift_merged',
      details: { winner: { id: shiftA } },
    });
    const conflicts = await t.db.syncConflict.findMany();
    expect(conflicts.map((c) => c.kind)).toEqual(['shift_close_discarded']);
  });

  it('cerrar dos veces el mismo turno: el segundo cierre se rechaza', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairAnother(a.branchId);
    const shift = randomUUID();
    await t.push(a.token, [shiftOpened(shift)]);
    await t.push(a.token, [shiftClosed(shift, { closingCountedCashCents: 100 })]);

    const res = await t.push(b.token, [shiftClosed(shift, { closingCountedCashCents: 999 })]);
    expect(res.body.rejected[0]).toMatchObject({
      code: 'invalid_transition',
      details: { currentType: 'shift', current: { closingCountedCashCents: 100 } },
    });
  });

  it('dos aperturas concurrentes: exactamente una gana', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairAnother(a.branchId);
    const [ra, rb] = await Promise.all([
      t.push(a.token, [shiftOpened(randomUUID())]),
      t.push(b.token, [shiftOpened(randomUUID())]),
    ]);
    const accepted = ra.body.accepted.length + rb.body.accepted.length;
    const conflicts = [...ra.body.rejected, ...rb.body.rejected];
    expect(accepted).toBe(1);
    expect(conflicts.map((r: { code: string }) => r.code)).toEqual(['shift_conflict']);
  });

  it('cerrado el turno, se puede abrir otro', async () => {
    const a = await t.pairedDevice();
    const first = randomUUID();
    await t.push(a.token, [shiftOpened(first), shiftClosed(first)]);
    const res = await t.push(a.token, [shiftOpened(randomUUID())]);
    expect(res.body.rejected).toEqual([]);
  });
});

describe('árbitro: pedidos', () => {
  it('cobrar un pedido cancelado gana: queda cumplido con versión mayor', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairAnother(a.branchId);
    const order = randomUUID();
    const shift = randomUUID();
    await t.push(a.token, [shiftOpened(shift), orderCreated(order)]);
    await t.push(a.token, [orderCancelled(order)]); // v2

    const charge = sale(shift, { orderId: order, orderVersion: 2 });
    const res = await t.push(b.token, [charge]);
    expect(res.body.accepted).toHaveLength(1);

    const stored = (await pulledOf(a.token)).find((e) => e.type === 'sale.created')!;
    expect(stored.payload.incomingOrder).toMatchObject({ status: 'fulfilled', version: 3 });
    const state = await t.db.aggregateState.findFirst({ where: { aggregateId: order } });
    expect(state).toMatchObject({ status: 'fulfilled', version: 3 });
  });

  it('cancelar un pedido ya cobrado se rechaza con el pedido vigente', async () => {
    const a = await t.pairedDevice();
    const order = randomUUID();
    const shift = randomUUID();
    await t.push(a.token, [shiftOpened(shift), orderCreated(order)]);
    await t.push(a.token, [sale(shift, { orderId: order })]);

    const res = await t.push(a.token, [orderCancelled(order)]);
    expect(res.body.rejected[0]).toMatchObject({
      code: 'invalid_transition',
      details: { currentType: 'incoming_order', current: { status: 'fulfilled' } },
    });
  });

  it('un doble cobro se acepta y queda registrado como conflicto', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairAnother(a.branchId);
    const order = randomUUID();
    const shift = randomUUID();
    await t.push(a.token, [shiftOpened(shift), orderCreated(order)]);
    await t.push(a.token, [sale(shift, { orderId: order })]);

    const second = sale(shift, { orderId: order });
    const res = await t.push(b.token, [second]);
    expect(res.body.accepted).toHaveLength(1);
    const conflicts = await t.db.syncConflict.findMany();
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: 'order_double_charge', eventId: second.eventId }),
    ]);
    const stored = (await pulledOf(a.token)).filter((e) => e.type === 'sale.created');
    expect(stored[1]!.payload.incomingOrder).toBeNull();
  });
});

describe('árbitro: last-write-wins', () => {
  it('misma versión: gana la primera y la segunda recibe la vigente', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairAnother(a.branchId);
    const product = randomUUID();
    await t.push(a.token, [productUpserted(product, 1, 'Taro')]);
    await t.push(a.token, [productUpserted(product, 2, 'Taro grande')]);

    const res = await t.push(b.token, [productUpserted(product, 2, 'Taro XL')]);
    expect(res.body.rejected[0]).toMatchObject({
      code: 'stale_version',
      details: { currentType: 'product', current: { name: 'Taro grande', version: 2 } },
    });
    expect((await t.push(b.token, [productUpserted(product, 3, 'Taro XL')])).body.accepted)
      .toHaveLength(1);
  });

  it('un reenvío sigue siendo duplicado (no se re-arbitra)', async () => {
    const a = await t.pairedDevice();
    const event = productUpserted(randomUUID(), 1, 'Matcha');
    await t.push(a.token, [event]);
    const again = await t.push(a.token, [event]);
    expect(again.body.duplicates).toEqual([event.eventId]);
    expect(again.body.rejected).toEqual([]);
  });

  it('rebuildProjections reproduce el mismo estado', async () => {
    const a = await t.pairedDevice();
    const order = randomUUID();
    const shift = randomUUID();
    await t.push(a.token, [
      shiftOpened(shift),
      orderCreated(order),
      sale(shift, { orderId: order }),
      productUpserted(randomUUID(), 1, 'Coco'),
    ]);
    const snapshot = async () =>
      (
        await t.db.aggregateState.findMany({
          orderBy: [{ aggregateType: 'asc' }, { aggregateId: 'asc' }],
        })
      ).map(({ updatedAt: _u, ...rest }) => rest);
    const before = await snapshot();

    const res = await t.admin().post('/projections/rebuild', { branchId: a.branchId });
    expect(res.body.events).toBe(4);
    expect(await snapshot()).toEqual(before);
  });
});
