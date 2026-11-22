import { derivedEventId, insertEvent } from './events.js';
import type { Tx } from './rules.js';

type Row = Record<string, unknown>;

/// Copia el catálogo vigente de [fromBranchId] a [toBranchId] como eventos
/// `*.upserted` (con los mismos ids y fotos: los medios son de la
/// organización). Los insumos llegan sin movimientos: existencia en cero.
/// Orden: lo referenciado antes que lo que lo referencia.
export async function copyCatalog(
  tx: Tx,
  opts: { organizationId: string; fromBranchId: string; toBranchId: string; deviceId: string },
): Promise<{ last: bigint | null; copied: number }> {
  const from = { branchId: opts.fromBranchId };
  const sets: { type: string; aggregateType: string; rows: { id: string; row: unknown }[] }[] = [
    {
      type: 'category.upserted',
      aggregateType: 'category',
      rows: await tx.branchCategory.findMany({ where: from, orderBy: { id: 'asc' } }),
    },
    {
      type: 'modifier_group.upserted',
      aggregateType: 'modifier_group',
      rows: await tx.branchModifierGroup.findMany({ where: from, orderBy: { id: 'asc' } }),
    },
    {
      type: 'modifier_option.upserted',
      aggregateType: 'modifier_option',
      rows: await tx.branchModifierOption.findMany({ where: from, orderBy: { id: 'asc' } }),
    },
    {
      type: 'supply.upserted',
      aggregateType: 'supply',
      rows: await tx.branchSupply.findMany({ where: from, orderBy: { id: 'asc' } }),
    },
    {
      type: 'product.upserted',
      aggregateType: 'product',
      rows: await tx.branchProduct.findMany({ where: from, orderBy: { id: 'asc' } }),
    },
    {
      type: 'product_modifier_group.upserted',
      aggregateType: 'product_modifier_group',
      rows: (
        await tx.branchProductModifierGroup.findMany({
          where: from,
          orderBy: [{ productId: 'asc' }, { modifierGroupId: 'asc' }],
        })
      ).map((l) => ({ id: `${l.productId}:${l.modifierGroupId}`, row: l.row })),
    },
  ];

  const createdAt = new Date();
  let last: bigint | null = null;
  let copied = 0;
  for (const set of sets) {
    for (const { id, row } of set.rows) {
      last = await insertEvent(tx, {
        eventId: derivedEventId('catalog', set.aggregateType, id, opts.toBranchId),
        organizationId: opts.organizationId,
        branchId: opts.toBranchId,
        deviceId: opts.deviceId,
        type: set.type,
        aggregateType: set.aggregateType,
        aggregateId: id,
        payload: { ...(row as Row), v: 1 },
        createdAt,
      });
      copied++;
    }
  }
  return { last, copied };
}
