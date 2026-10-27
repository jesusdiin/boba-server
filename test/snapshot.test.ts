import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  envelope,
  orderCreated,
  saleCreatedEvent,
  setupTestApp,
  shiftOpened,
  userUpdatedEvent,
} from './helpers.js';

const t = setupTestApp();
const at = '2026-08-20T18:00:00.000Z';

describe('GET /v1/branches/:id/snapshot', () => {
  it('devuelve un snapshot vacío para una sucursal sin eventos', async () => {
    const { token, branchId } = await t.pairedDevice();
    const res = await t.snapshot(token, branchId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      snapshotVersion: 1,
      branchId,
      serverSeq: '0',
    });
    for (const rows of Object.values(res.body.tables) as unknown[][]) {
      expect(rows).toEqual([]);
    }
  });

  it('proyecta ventas, turnos, usuarios y movimientos en el snapshot', async () => {
    const { token, branchId } = await t.pairedDevice();
    const shiftId = randomUUID();
    const supplyId = randomUUID();
    const cashId = randomUUID();
    const supplyMovementId = randomUUID();
    const sale = saleCreatedEvent();
    const order = orderCreated(randomUUID());
    const supply = envelope('supply.upserted', 'supply', supplyId, {
      id: supplyId,
      name: 'Té negro',
      category: 'Tés',
      unit: 'kg',
      supplierName: null,
      leadTimeHours: 24,
      minQuantityMilli: 500000,
      unitCostCents: 12000,
      sortOrder: 0,
      isActive: true,
      createdAtUtc: at,
      updatedAtUtc: at,
      version: 1,
    });
    const cash = envelope('cash_movement.created', 'cash_movement', cashId, {
      id: cashId,
      shiftId,
      deviceId: 'd',
      branchId,
      businessDate: '2026-08-20',
      kind: 'expense',
      category: 'supplies',
      concept: 'Servilletas',
      amountCents: 3500,
      counterparty: null,
      userId: null,
      createdAtUtc: at,
    });
    const supplyMovement = envelope(
      'supply_movement.created',
      'supply_movement',
      supplyMovementId,
      {
        id: supplyMovementId,
        supplyId,
        kind: 'entry',
        quantityDeltaMilli: 1000000,
        unitCostCents: 12000,
        note: null,
        userId: null,
        shiftId,
        deviceId: 'd',
        businessDate: '2026-08-20',
        createdAtUtc: at,
      },
    );

    const pushed = await t.push(token, [
      shiftOpened(shiftId),
      userUpdatedEvent(),
      supply,
      sale,
      cash,
      supplyMovement,
      order,
    ]);
    expect(pushed.status).toBe(200);
    expect(pushed.body.rejected).toEqual([]);

    const res = await t.snapshot(token, branchId);
    expect(res.status).toBe(200);
    expect(res.body.tables.shifts).toHaveLength(1);
    expect(res.body.tables.users).toHaveLength(1);
    expect(res.body.tables.supplies).toHaveLength(1);
    expect(res.body.tables.sales).toHaveLength(1);
    expect(res.body.tables.sale_items).toHaveLength(1);
    expect(res.body.tables.sale_item_modifiers).toHaveLength(1);
    expect(res.body.tables.payments).toHaveLength(1);
    expect(res.body.tables.cash_movements).toHaveLength(1);
    expect(res.body.tables.supply_movements).toHaveLength(1);
    expect(res.body.tables.incoming_orders).toHaveLength(1);
    expect(res.body.tables.sales[0]).toMatchObject({
      id: sale.aggregateId,
      businessDate: '2026-08-20',
      totalCents: 13000,
    });

    const max = await t.db.event.aggregate({ _max: { serverSeq: true } });
    expect(res.body.serverSeq).toBe(max._max.serverSeq!.toString());

    // Reportes: las columnas extraídas también quedaron pobladas.
    const saleRow = await t.db.branchSale.findFirstOrThrow({
      where: { branchId, id: sale.aggregateId },
    });
    expect(saleRow.totalCents).toBe(13000);
    expect(saleRow.channel).toBe('instagram');
    expect(await t.db.branchPayment.count({ where: { branchId } })).toBe(1);
    expect(await t.db.branchCashMovement.count({ where: { branchId } })).toBe(1);
    expect(await t.db.branchSupplyMovement.count({ where: { branchId } })).toBe(1);
  });

  it('el rebuild deja el mismo snapshot', async () => {
    const { token, branchId } = await t.pairedDevice();
    const shiftId = randomUUID();
    await t.push(token, [shiftOpened(shiftId), userUpdatedEvent(), saleCreatedEvent()]);

    const before = (await t.snapshot(token, branchId)).body;
    const rebuilt = await t.admin().post('/projections/rebuild', { branchId });
    expect(rebuilt.status).toBe(200);
    const after = (await t.snapshot(token, branchId)).body;

    expect(after).toMatchObject({
      snapshotVersion: before.snapshotVersion,
      branchId: before.branchId,
      serverSeq: before.serverSeq,
      tables: before.tables,
    });
  });

  it('el cursor del snapshot continúa con el pull incremental', async () => {
    const { token, branchId } = await t.pairedDevice();
    await t.push(token, [userUpdatedEvent()]);
    const snapshot = (await t.snapshot(token, branchId)).body;

    const empty = await t.pull(token, { after: snapshot.serverSeq });
    expect(empty.body.events).toEqual([]);

    const next = userUpdatedEvent();
    await t.push(token, [next]);
    const page = await t.pull(token, { after: snapshot.serverSeq });
    expect(page.body.events.map((e: { eventId: string }) => e.eventId)).toEqual([
      next.eventId,
    ]);
  });

  it('no deja leer otra sucursal ni sin token', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairedDevice();

    expect((await t.snapshot(b.token, a.branchId)).status).toBe(404);
    expect((await t.snapshot('token-falso', a.branchId)).status).toBe(401);
  });

  it('responde 409 si hay eventos pero falta el backfill de proyecciones', async () => {
    const { token, branchId } = await t.pairedDevice();
    await t.push(token, [userUpdatedEvent()]);
    await t.db.branchUser.deleteMany({ where: { branchId } });

    const res = await t.snapshot(token, branchId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('snapshot_not_ready');
  });
});
