import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { formatMoney, formatQuantity } from '../src/push/branchNotices.js';
import { FakePushSender } from '../src/push/sender.js';
import {
  envelope,
  orderCreated,
  sale,
  setupTestApp,
  shiftClosed,
  shiftOpened,
} from './helpers.js';

const fcm = (name: string) => `fcm-${name}-${'x'.repeat(20)}`;

/// Lo que pasó ahora mismo (los avisos solo salen de eventos recientes).
function fresh<T extends { createdAtUtc: string }>(event: T): T {
  return { ...event, createdAtUtc: new Date().toISOString() };
}

const supplyUpserted = (id: string, minQuantityMilli: number) =>
  envelope('supply.upserted', 'supply', id, {
    id,
    name: 'Leche',
    category: 'Lácteos',
    unit: 'liter',
    supplierName: null,
    leadTimeHours: 24,
    minQuantityMilli,
    unitCostCents: 2500,
    sortOrder: 0,
    isActive: true,
    version: 1,
  });

const supplyMovement = (supplyId: string, delta: number) => {
  const id = randomUUID();
  return envelope('supply_movement.created', 'supply_movement', id, {
    id,
    supplyId,
    kind: delta > 0 ? 'entry' : 'waste',
    quantityDeltaMilli: delta,
    unitCostCents: null,
    note: null,
    userId: null,
    shiftId: null,
    deviceId: 'd',
    businessDate: '2026-08-20',
    createdAtUtc: new Date().toISOString(),
  });
};

/// Venta (v3) que consume [delta] milésimas de [supplyId].
function saleConsuming(shiftId: string, supplyId: string, delta: number) {
  const event = sale(shiftId);
  const saleId = (event.payload as unknown as { sale: { id: string } }).sale.id;
  return fresh({
    ...event,
    payload: {
      ...event.payload,
      v: 3,
      supplyMovements: [
        {
          id: randomUUID(),
          supplyId,
          kind: 'sale',
          quantityDeltaMilli: delta,
          unitCostCents: null,
          note: null,
          userId: null,
          shiftId,
          deviceId: 'd',
          saleId,
          businessDate: '2026-08-20',
          createdAtUtc: new Date().toISOString(),
        },
      ],
    },
  });
}

describe('avisos automáticos a los equipos de la sucursal', () => {
  const pushSender = new FakePushSender();
  const t = setupTestApp({ pushSender });

  const register = (token: string, deviceToken: string, mutedTopics?: string[]) =>
    request(t.app)
      .put('/v1/push/token')
      .set('authorization', `Bearer ${deviceToken}`)
      .send({ token, platform: 'android', ...(mutedTopics ? { mutedTopics } : {}) });

  /// Caja (origen), una tablet de la misma sucursal, un kiosco y otra sucursal.
  async function branchWithInstalls() {
    pushSender.sends.length = 0;
    const caja = await t.pairedDevice();
    const tablet = await t.pairAnother(caja.branchId, 'Tablet barra');
    const kiosk = await t.pairAnother(caja.branchId, 'Kiosco');
    await t.db.device.update({ where: { id: kiosk.deviceId }, data: { mode: 'kiosk' } });
    const other = await t.pairedDevice({ orgId: caja.orgId });
    await register(fcm('caja'), caja.token);
    await register(fcm('tablet'), tablet.token);
    await register(fcm('kiosk'), kiosk.token);
    await register(fcm('other'), other.token);
    return { caja, tablet };
  }

  const sent = () => pushSender.sends.map((s) => ({ tokens: s.tokens, ...s.message }));

  it('un pedido nuevo avisa a los otros equipos de la sucursal (no al que lo hizo, ni al kiosco, ni a otra sucursal)', async () => {
    const { caja } = await branchWithInstalls();
    const order = fresh(
      orderCreated(randomUUID(), {
        folio: 'A-012',
        channel: 'kiosk',
        customerName: 'Ana',
        itemsJson: JSON.stringify([{}, {}, {}]),
      }),
    );
    const res = await t.push(caja.token, [order]);
    expect(res.body.accepted).toHaveLength(1);

    await vi.waitFor(() => expect(pushSender.sends).toHaveLength(1));
    expect(sent()).toEqual([
      {
        tokens: [fcm('tablet')],
        title: 'Pedido nuevo · A-012',
        body: 'Kiosco · Ana · 3 productos',
      },
    ]);
  });

  it('abrir y cerrar caja avisan con el fondo y la diferencia del corte', async () => {
    const { caja } = await branchWithInstalls();
    const shift = randomUUID();
    await t.push(caja.token, [
      fresh(shiftOpened(shift)),
      fresh(
        shiftClosed(shift, {
          closingCountedCashCents: 185000,
          closingExpectedCashCents: 190000,
        }),
      ),
    ]);

    await vi.waitFor(() => expect(pushSender.sends).toHaveLength(2));
    expect(sent().map((s) => [s.title, s.body])).toEqual([
      ['Caja abierta · Centro', 'Fondo $1,000'],
      ['Caja cerrada · Centro', 'Contado $1,850 · esperado $1,900 · faltan $50'],
    ]);
  });

  it('un insumo avisa solo al bajar de su mínimo, no en cada venta', async () => {
    const { caja } = await branchWithInstalls();
    const shift = randomUUID();
    const milk = randomUUID();
    // 2.5 L, mínimo 2 L.
    await t.push(caja.token, [
      shiftOpened(shift),
      supplyUpserted(milk, 2000),
      { ...supplyMovement(milk, 2500), createdAtUtc: '2026-08-20T15:00:00.000Z' },
    ]);
    pushSender.sends.length = 0;

    // 2.5 → 2.2: sigue arriba del mínimo.
    await t.push(caja.token, [saleConsuming(shift, milk, -300)]);
    // 2.2 → 1.8: cruza.
    await t.push(caja.token, [saleConsuming(shift, milk, -400)]);
    // 1.8 → 1.5: ya estaba abajo, no se repite.
    await t.push(caja.token, [saleConsuming(shift, milk, -300)]);

    await vi.waitFor(() => expect(pushSender.sends).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent()).toEqual([
      {
        tokens: [fcm('tablet')],
        title: 'Insumo bajo: Leche',
        body: 'Quedan 1.8 L (mínimo 2 L)',
      },
    ]);
  });

  it('respeta los tipos que la instalación apagó', async () => {
    const { caja, tablet } = await branchWithInstalls();
    await register(fcm('tablet'), tablet.token, ['orders']);
    const shift = randomUUID();
    await t.push(caja.token, [
      fresh(orderCreated(randomUUID())),
      fresh(shiftOpened(shift)),
    ]);

    await vi.waitFor(() => expect(pushSender.sends).toHaveLength(1));
    expect(sent()[0]!.title).toBe('Caja abierta · Centro');
  });

  it('lo que pasó hace rato (equipo que vuelve a tener red) no avisa', async () => {
    const { caja } = await branchWithInstalls();
    const old = orderCreated(randomUUID());
    old.createdAtUtc = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const res = await t.push(caja.token, [old]);
    expect(res.body.accepted).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(pushSender.sends).toHaveLength(0);
  });

  it('las campañas del panel no llegan a quien apagó "Novedades"', async () => {
    const { tablet } = await branchWithInstalls();
    await register(fcm('tablet'), tablet.token, ['news']);
    const row = await t.db.pushToken.findUniqueOrThrow({
      where: { token: fcm('tablet') },
    });
    expect(row.mutedTopics).toEqual(['news']);
    // Registrar sin el campo (app anterior) no borra las preferencias.
    await request(t.app)
      .put('/v1/push/token')
      .set('authorization', `Bearer ${tablet.token}`)
      .send({ token: fcm('tablet'), platform: 'android' });
    expect(
      (await t.db.pushToken.findUniqueOrThrow({ where: { token: fcm('tablet') } }))
        .mutedTopics,
    ).toEqual(['news']);
  });

  it('un tipo desconocido se rechaza', async () => {
    const { tablet } = await branchWithInstalls();
    const res = await register(fcm('tablet'), tablet.token, ['spam']);
    expect(res.status).toBe(400);
  });
});

describe('si FCM falla, el sync responde igual', () => {
  const failing = new FakePushSender();
  failing.send = () => Promise.reject(new Error('FCM caído'));
  const t = setupTestApp({ pushSender: failing });

  it('el push se acepta', async () => {
    const caja = await t.pairedDevice();
    const tablet = await t.pairAnother(caja.branchId, 'Tablet');
    await request(t.app)
      .put('/v1/push/token')
      .set('authorization', `Bearer ${tablet.token}`)
      .send({ token: fcm('tablet'), platform: 'android' });
    const res = await t.push(caja.token, [fresh(orderCreated(randomUUID()))]);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toHaveLength(1);
  });
});

describe('formato', () => {
  it('dinero y cantidades', () => {
    expect(formatMoney(185000, 'MXN')).toBe('$1,850');
    expect(formatMoney(185050, 'MXN')).toBe('$1,850.50');
    expect(formatQuantity(1800, 'liter')).toBe('1.8 L');
    expect(formatQuantity(3000, 'piece')).toBe('3 pz');
    expect(formatQuantity(-200, 'kg')).toBe('0 kg');
  });
});
