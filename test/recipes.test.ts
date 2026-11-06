import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sale, setupTestApp, shiftOpened } from './helpers.js';

const t = setupTestApp();

/// `sale.created` v3: el consumo de insumos según las recetas.
function saleWithConsumption(shiftId: string, supplyId: string) {
  const event = sale(shiftId);
  const saleId = event.aggregateId;
  const movement = {
    id: randomUUID(),
    supplyId,
    kind: 'sale',
    quantityDeltaMilli: -120,
    unitCostCents: 9000,
    note: 'Venta A-001',
    userId: null,
    shiftId,
    deviceId: 'd',
    businessDate: '2026-08-20',
    saleId,
    createdAtUtc: '2026-08-20T18:00:00.000Z',
  };
  return {
    ...event,
    payload: { ...event.payload, v: 3, supplyMovements: [movement] },
  };
}

describe('sale.created v3 (consumo por recetas)', () => {
  it('proyecta el consumo como movimientos de insumo y viaja en el snapshot', async () => {
    const { token, branchId } = await t.pairedDevice();
    const shift = randomUUID();
    const supply = randomUUID();
    const res = await t.push(token, [shiftOpened(shift), saleWithConsumption(shift, supply)]);
    expect(res.body.accepted).toHaveLength(2);

    const snapshot = (await t.snapshot(token, branchId)).body;
    expect(snapshot.tables.supply_movements).toEqual([
      expect.objectContaining({ supplyId: supply, kind: 'sale', quantityDeltaMilli: -120 }),
    ]);
  });

  it('una venta sin consumo (v2) se sigue aceptando', async () => {
    const { token } = await t.pairedDevice();
    const shift = randomUUID();
    const res = await t.push(token, [shiftOpened(shift), sale(shift)]);
    expect(res.body.accepted).toHaveLength(2);
  });
});
