import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { envelope, orderCreated, sale, setupTestApp, shiftOpened } from './helpers.js';

const t = setupTestApp();

const modeChanged = (deviceId: string, mode: string) =>
  envelope('device.mode_changed', 'device', deviceId, { v: 1, deviceId, mode });

const kioskOrder = (extra: Record<string, unknown> = {}) =>
  orderCreated(randomUUID(), { channel: 'kiosk', ...extra });

describe('modo kiosco', () => {
  it('en kiosco solo se aceptan pedidos de kiosco', async () => {
    const a = await t.pairedDevice();
    const shift = randomUUID();
    await t.push(a.token, [shiftOpened(shift)]);

    const res = await t.push(a.token, [
      modeChanged(a.deviceId, 'kiosk'),
      kioskOrder(),
      sale(shift),
      kioskOrder({ createdByUserId: randomUUID() }),
      orderCreated(randomUUID(), { channel: 'instagram' }),
    ]);

    expect(res.body.accepted).toHaveLength(2);
    expect(res.body.rejected.map((r: { code: string }) => r.code)).toEqual([
      'kiosk_forbidden',
      'kiosk_forbidden',
      'kiosk_forbidden',
    ]);
    const device = await t.db.device.findUnique({ where: { id: a.deviceId } });
    expect(device?.mode).toBe('kiosk');
  });

  it('respeta el orden: lo anterior al cambio sube como staff', async () => {
    const a = await t.pairedDevice();
    const shift = randomUUID();
    const res = await t.push(a.token, [
      shiftOpened(shift),
      sale(shift),
      modeChanged(a.deviceId, 'kiosk'),
      sale(shift),
      modeChanged(a.deviceId, 'staff'),
      sale(shift),
    ]);
    expect(res.body.accepted).toHaveLength(5);
    expect(res.body.rejected).toEqual([
      expect.objectContaining({ code: 'kiosk_forbidden' }),
    ]);
  });

  it('el cambio de modo aplica al dispositivo del token, no al del payload', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairAnother(a.branchId);
    await t.push(a.token, [modeChanged(b.deviceId, 'kiosk')]);

    const devices = await t.db.device.findMany({ orderBy: { createdAt: 'asc' } });
    expect(devices.map((d) => d.mode)).toEqual(['kiosk', 'staff']);
  });

  it('los demás dispositivos reciben el pedido del kiosco', async () => {
    const kiosk = await t.pairedDevice();
    const cashier = await t.pairAnother(kiosk.branchId);
    const order = kioskOrder();
    await t.push(kiosk.token, [modeChanged(kiosk.deviceId, 'kiosk'), order]);

    const pulled = (await t.pull(cashier.token)).body.events;
    expect(pulled.map((e: { type: string }) => e.type)).toEqual([
      'device.mode_changed',
      'incoming_order.created',
    ]);
  });
});
