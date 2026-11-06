import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { envelope, orderCreated, orderRow, sale, setupTestApp, shiftOpened } from './helpers.js';

const t = setupTestApp();

const prepChanged = (id: string, prepStatus: string, version: number) =>
  envelope(
    'incoming_order.prep_changed',
    'incoming_order',
    id,
    orderRow(id, { prepStatus, version }),
  );

describe('incoming_order.prep_changed (preparación)', () => {
  it('avanza la preparación de un pedido pendiente y la ven los demás', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairAnother(a.branchId);
    const order = randomUUID();
    await t.push(a.token, [orderCreated(order)]);

    const res = await t.push(a.token, [
      prepChanged(order, 'preparing', 2),
      prepChanged(order, 'ready', 3),
    ]);
    expect(res.body.accepted).toHaveLength(2);

    const events = (await t.pull(b.token)).body.events as { type: string; payload: { prepStatus?: string } }[];
    expect(events.at(-1)).toMatchObject({
      type: 'incoming_order.prep_changed',
      payload: { prepStatus: 'ready' },
    });
  });

  it('un cambio viejo se rechaza por versión', async () => {
    const a = await t.pairedDevice();
    const order = randomUUID();
    await t.push(a.token, [orderCreated(order), prepChanged(order, 'ready', 3)]);
    const res = await t.push(a.token, [prepChanged(order, 'preparing', 2)]);
    expect(res.body.rejected[0]).toMatchObject({ code: 'stale_version' });
  });

  it('no se prepara un pedido ya cobrado', async () => {
    const a = await t.pairedDevice();
    const order = randomUUID();
    const shift = randomUUID();
    await t.push(a.token, [shiftOpened(shift), orderCreated(order)]);
    await t.push(a.token, [sale(shift, { orderId: order })]);

    const res = await t.push(a.token, [prepChanged(order, 'preparing', 5)]);
    expect(res.body.rejected[0]).toMatchObject({
      code: 'invalid_transition',
      details: { current: { status: 'fulfilled' } },
    });
  });
});
