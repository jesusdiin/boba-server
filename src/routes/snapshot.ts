import { Router } from 'express';

import { requireDevice } from '../auth/deviceAuth.js';
import type { Db } from '../db.js';
import { HttpError, notFound } from '../errors.js';

export const SNAPSHOT_VERSION = 1;

type Row = Record<string, unknown>;

const rowsOf = (values: { row: unknown }[]): Row[] => {
  return values.map((value) =>
    value.row && typeof value.row === 'object' && !Array.isArray(value.row)
      ? (value.row as Row)
      : {},
  );
};

/// Snapshot de arranque para un dispositivo nuevo. No es el log: es el estado
/// vigente de las proyecciones, ya en la forma que entiende la app. El cliente
/// restaura las filas tal cual y sigue con un pull desde `serverSeq`.
export function snapshotRouter(db: Db): Router {
  const router = Router();

  router.get('/:branchId/snapshot', async (req, res) => {
    const device = requireDevice(req.device);
    const branchId = req.params.branchId;
    // La sucursal sale del token. No revelamos si existe otra.
    if (branchId !== device.branchId) throw notFound('Sucursal no encontrada');

    const snapshot = await db.$transaction(
      async (tx) => {
        const max = await tx.event.aggregate({
          where: { branchId },
          _max: { serverSeq: true },
        });
        const serverSeq = max._max.serverSeq ?? 0n;

        const [
          categories,
          products,
          modifierGroups,
          modifierOptions,
          productModifierGroups,
          supplies,
          users,
          shifts,
          sales,
          saleItems,
          saleItemModifiers,
          payments,
          cashMovements,
          supplyMovements,
          incomingOrders,
        ] = await Promise.all([
          tx.branchCategory.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchProduct.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchModifierGroup.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchModifierOption.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchProductModifierGroup.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: [{ productId: 'asc' }, { modifierGroupId: 'asc' }],
          }),
          tx.branchSupply.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchUser.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchShift.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchSale.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchSaleItem.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchSaleItemModifier.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchPayment.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchCashMovement.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchSupplyMovement.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
          tx.branchIncomingOrder.findMany({
            where: { branchId },
            select: { row: true },
            orderBy: { id: 'asc' },
          }),
        ]);

        const tables = {
          categories: rowsOf(categories),
          products: rowsOf(products),
          modifier_groups: rowsOf(modifierGroups),
          modifier_options: rowsOf(modifierOptions),
          product_modifier_groups: rowsOf(productModifierGroups),
          supplies: rowsOf(supplies),
          users: rowsOf(users),
          shifts: rowsOf(shifts),
          sales: rowsOf(sales),
          sale_items: rowsOf(saleItems),
          sale_item_modifiers: rowsOf(saleItemModifiers),
          payments: rowsOf(payments),
          cash_movements: rowsOf(cashMovements),
          supply_movements: rowsOf(supplyMovements),
          incoming_orders: rowsOf(incomingOrders),
        };

        // Si hay eventos pero ninguna proyección, falta el backfill. Mejor
        // que el POS caiga al pull completo a que restaure una sucursal vacía.
        if (serverSeq > 0n && Object.values(tables).every((rows) => rows.length === 0)) {
          throw new HttpError(
            409,
            'snapshot_not_ready',
            'Las proyecciones de la sucursal aún no están listas',
          );
        }

        return {
          snapshotVersion: SNAPSHOT_VERSION,
          branchId,
          serverSeq: serverSeq.toString(),
          generatedAt: new Date().toISOString(),
          tables,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );

    res.json(snapshot);
  });

  return router;
}
