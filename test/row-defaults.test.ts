import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { withEventDefaults, withRowDefaults } from '../src/sync/rowDefaults.js';
import { envelope, productUpserted, setupTestApp } from './helpers.js';

const t = setupTestApp();
const at = '2026-08-20T18:00:00.000Z';

/// Usuario como lo subía una versión vieja de la app (sin `isActive`).
const oldUser = (id: string) =>
  envelope('user.created', 'user', id, {
    id,
    displayName: 'Ana',
    role: 'cashier',
    pinHash: 'h',
    pinSalt: 's',
    createdAtUtc: at,
    updatedAtUtc: at,
    version: 1,
  });

describe('booleanos faltantes de versiones viejas de la app', () => {
  it('rellena solo lo que falta o es null y nunca pisa un valor', () => {
    expect(withRowDefaults('product', { id: 'p' })).toEqual({
      id: 'p',
      isActive: true,
      isSoldOut: false,
    });
    expect(withRowDefaults('product', { isActive: false, isSoldOut: null })).toEqual({
      isActive: false,
      isSoldOut: false,
    });
    const sale = { id: 's' };
    expect(withEventDefaults('sale.created', sale)).toBe(sale);
    expect(withEventDefaults('user.updated', { id: 'u' })).toEqual({
      id: 'u',
      isActive: true,
    });
  });

  it('el pull completa los eventos viejos', async () => {
    const a = await t.pairedDevice();
    const product = randomUUID();
    const user = randomUUID();
    const push = await t.push(a.token, [
      productUpserted(product, 1, 'Taro'),
      oldUser(user),
    ]);
    expect(push.body.rejected).toEqual([]);

    const res = await t.pull(a.token, { after: 0 });
    const payload = (type: string) =>
      res.body.events.find((e: { type: string }) => e.type === type).payload;
    expect(payload('product.upserted')).toMatchObject({
      isActive: true,
      isSoldOut: false,
    });
    expect(payload('user.created')).toMatchObject({ isActive: true });
  });

  it('el snapshot completa las filas guardadas sin los campos', async () => {
    const a = await t.pairedDevice();
    const product = randomUUID();
    const user = randomUUID();
    await t.push(a.token, [productUpserted(product, 1, 'Taro'), oldUser(user)]);
    // Como quedaron en producción antes del arreglo: la fila sin los campos.
    await t.db
      .$executeRaw`UPDATE branch_products SET row = row - 'isSoldOut' - 'isActive' WHERE id = ${product}`;
    await t.db
      .$executeRaw`UPDATE branch_users SET row = row - 'isActive' WHERE id = ${user}`;

    const snap = (await t.snapshot(a.token, a.branchId)).body;
    const p = snap.tables.products.find((r: { id: string }) => r.id === product);
    const u = snap.tables.users.find((r: { id: string }) => r.id === user);
    expect(p).toMatchObject({ isActive: true, isSoldOut: false });
    expect(u).toMatchObject({ isActive: true });
  });

  it('un false existente se respeta', async () => {
    const a = await t.pairedDevice();
    const product = randomUUID();
    await t.push(a.token, [
      envelope('product.upserted', 'product', product, {
        id: product,
        name: 'Taro',
        basePriceCents: 5000,
        isActive: false,
        isSoldOut: true,
        version: 1,
      }),
    ]);
    const snap = (await t.snapshot(a.token, a.branchId)).body;
    expect(
      snap.tables.products.find((r: { id: string }) => r.id === product),
    ).toMatchObject({
      isActive: false,
      isSoldOut: true,
    });
  });
});
