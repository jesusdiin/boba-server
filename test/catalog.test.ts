import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { roleCan } from '../src/sync/permissions.js';
import { envelope, setupTestApp } from './helpers.js';

const t = setupTestApp();

const link = (productId: string, modifierGroupId: string) =>
  envelope(
    'product_modifier_group.upserted',
    'product_modifier_group',
    `${productId}:${modifierGroupId}`,
    { productId, modifierGroupId, sortOrder: 0, createdAtUtc: '2026-08-20T15:00:00.000Z' },
  );

const unlink = (productId: string, modifierGroupId: string) =>
  envelope(
    'product_modifier_group.removed',
    'product_modifier_group',
    `${productId}:${modifierGroupId}`,
    { productId, modifierGroupId },
  );

describe('catálogo: quitar un grupo de un producto', () => {
  it('removed borra la unión de la proyección y es idempotente', async () => {
    const a = await t.pairedDevice();
    const product = randomUUID();
    const group = randomUUID();
    const count = () =>
      t.db.branchProductModifierGroup.count({
        where: { branchId: a.branchId, productId: product, modifierGroupId: group },
      });

    expect((await t.push(a.token, [link(product, group)])).body.accepted).toHaveLength(1);
    expect(await count()).toBe(1);

    const removed = await t.push(a.token, [unlink(product, group)]);
    expect(removed.body.accepted).toHaveLength(1);
    expect(await count()).toBe(0);

    // Otra vez (p. ej. desde otro dispositivo): se acepta y no falla.
    expect((await t.push(a.token, [unlink(product, group)])).body.accepted).toHaveLength(1);

    // Volver a vincular la crea de nuevo; los demás dispositivos lo reciben.
    await t.push(a.token, [link(product, group)]);
    expect(await count()).toBe(1);
    const pulled = await t.pull(a.token);
    expect(pulled.body.events.map((e: { type: string }) => e.type)).toEqual([
      'product_modifier_group.upserted',
      'product_modifier_group.removed',
      'product_modifier_group.removed',
      'product_modifier_group.upserted',
    ]);
  });

  it('permisos de catálogo: admin todo; cajero solo agotado', () => {
    expect(roleCan('admin', 'manageCatalog')).toBe(true);
    expect(roleCan('cashier', 'manageCatalog')).toBe(false);
    expect(roleCan('cashier', 'markSoldOut')).toBe(true);
    expect(roleCan('waiter', 'markSoldOut')).toBe(false);
  });
});
