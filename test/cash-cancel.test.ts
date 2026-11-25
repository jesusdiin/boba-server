import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { envelope, setupTestApp, shiftOpened, userCreated } from './helpers.js';

const t = setupTestApp();

function cashMovement(
  shiftId: string,
  extra: Record<string, unknown> = {},
): ReturnType<typeof envelope> {
  const id = (extra.id as string | undefined) ?? randomUUID();
  return envelope('cash_movement.created', 'cash_movement', id, {
    id,
    shiftId,
    deviceId: 'd',
    branchId: 'b',
    businessDate: '2026-08-20',
    kind: 'expense',
    category: 'supplies',
    concept: 'Leche',
    amountCents: 30000,
    counterparty: null,
    userId: null,
    createdAtUtc: '2026-08-20T15:00:00.000Z',
    ...extra,
  });
}

/// Contramovimiento de [original] hecho por [userId].
const reversal = (
  shiftId: string,
  originalId: string,
  extra: Record<string, unknown> = {},
) =>
  cashMovement(shiftId, {
    kind: 'income',
    category: 'adjustment',
    concept: 'Cancelación: Leche',
    reversesId: originalId,
    ...extra,
  });

async function branchWithMovement() {
  const { token, branchId } = await t.pairedDevice();
  const shift = randomUUID();
  const cashier = userCreated('cashier');
  const admin = userCreated('admin');
  const original = cashMovement(shift);
  const res = await t.push(token, [cashier, admin, shiftOpened(shift), original]);
  expect(res.body.accepted).toHaveLength(4);
  return {
    token,
    branchId,
    shift,
    originalId: original.aggregateId,
    cashierId: cashier.aggregateId,
    adminId: admin.aggregateId,
  };
}

describe('cancelar un movimiento de caja (contramovimiento)', () => {
  it('un admin lo cancela; viaja en el pull y en el snapshot con reversesId', async () => {
    const b = await branchWithMovement();
    const r = reversal(b.shift, b.originalId, { userId: b.adminId });
    const res = await t.push(b.token, [r]);
    expect(res.body.accepted).toHaveLength(1);

    const other = await t.pairAnother(b.branchId, 'Tablet');
    const pulled = await t.pull(other.token);
    const event = pulled.body.events.find(
      (e: { aggregateId: string }) => e.aggregateId === r.aggregateId,
    );
    expect(event.payload).toMatchObject({ reversesId: b.originalId, kind: 'income' });

    const snapshot = await t.snapshot(other.token, b.branchId);
    expect(snapshot.body.tables.cash_movements).toEqual(
      expect.arrayContaining([expect.objectContaining({ reversesId: b.originalId })]),
    );
  });

  it('un cajero no puede cancelar (sí registrar)', async () => {
    const b = await branchWithMovement();
    const denied = await t.push(b.token, [
      reversal(b.shift, b.originalId, { userId: b.cashierId }),
    ]);
    expect(denied.body.rejected[0]).toMatchObject({ code: 'forbidden' });

    const ok = await t.push(b.token, [cashMovement(b.shift, { userId: b.cashierId })]);
    expect(ok.body.accepted).toHaveLength(1);
  });

  it('dos equipos cancelando el mismo: el segundo se rechaza', async () => {
    const b = await branchWithMovement();
    const first = await t.push(b.token, [
      reversal(b.shift, b.originalId, { userId: b.adminId }),
    ]);
    expect(first.body.accepted).toHaveLength(1);
    const second = await t.push(b.token, [
      reversal(b.shift, b.originalId, { userId: b.adminId }),
    ]);
    expect(second.body.rejected[0]).toMatchObject({ code: 'already_cancelled' });
  });

  it('rechaza: original inexistente, otro monto, mismo signo o cancelar una cancelación', async () => {
    const b = await branchWithMovement();
    const res = await t.push(b.token, [
      reversal(b.shift, randomUUID(), { userId: b.adminId }),
      reversal(b.shift, b.originalId, { userId: b.adminId, amountCents: 100 }),
      reversal(b.shift, b.originalId, { userId: b.adminId, kind: 'expense' }),
    ]);
    expect(res.body.rejected.map((r: { code: string }) => r.code)).toEqual([
      'invalid_event',
      'invalid_event',
      'invalid_event',
    ]);

    const r = reversal(b.shift, b.originalId, { userId: b.adminId });
    await t.push(b.token, [r]);
    const again = await t.push(b.token, [
      reversal(b.shift, r.aggregateId, { userId: b.adminId, kind: 'expense' }),
    ]);
    expect(again.body.rejected[0]).toMatchObject({ code: 'invalid_event' });
  });
});
