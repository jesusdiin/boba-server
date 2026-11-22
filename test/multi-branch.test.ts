import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { envelope, setupTestApp, shiftOpened, userCreated } from './helpers.js';

const t = setupTestApp();
const at = '2026-11-22T15:00:00.000Z';

/// Negocio Max con su Dueño y una segunda sucursal (con su equipo).
async function twoBranches() {
  const a = (await t.signup()).body as {
    token: string;
    deviceId: string;
    organizationId: string;
    branch: { id: string };
  };
  await t.admin().patch(`/organizations/${a.organizationId}/plan`, {
    plan: 'max',
    subscriptionStatus: 'active',
    currentPeriodEnd: null,
  });
  const owner = userCreated('owner');
  await t.push(a.token, [owner]);
  const created = await request(t.app)
    .post('/v1/org/branches')
    .set('authorization', `Bearer ${a.token}`)
    .set('x-boba-user', owner.aggregateId)
    .send({ name: 'Norte', copyCatalog: false });
  expect(created.status).toBe(201);
  const norte = await request(t.app)
    .post('/v1/devices/pair')
    .send({ code: created.body.pairingCode.code, deviceName: 'iPad Norte' });
  return {
    token: a.token,
    deviceId: a.deviceId,
    centro: a.branch.id,
    norte: created.body.branch.id as string,
    norteToken: norte.body.token as string,
    owner: owner.aggregateId,
  };
}

function cashier(
  actor: string | null,
  { id = randomUUID(), version = 1, branchIds, pinHash = 'h', type = 'user.created' }: {
    id?: string;
    version?: number;
    branchIds?: string[] | null;
    pinHash?: string;
    type?: string;
  } = {},
) {
  return envelope(type, 'user', id, {
    id,
    displayName: 'Luis',
    role: 'cashier',
    pinHash,
    pinSalt: 's',
    isActive: true,
    createdAtUtc: at,
    updatedAtUtc: at,
    version,
    actorUserId: actor,
    ...(branchIds === undefined ? {} : { branchIds }),
  });
}

const usersIn = async (token: string) =>
  ((await t.pull(token)).body.events as { type: string; payload: Record<string, unknown> }[])
    .filter((e) => e.type.startsWith('user.'))
    .map((e) => e.payload);

describe('usuarios en varias sucursales', () => {
  it('un cajero asignado a dos sucursales existe en las dos; sus cambios llegan', async () => {
    const b = await twoBranches();
    const luis = cashier(b.owner, { branchIds: [b.centro, b.norte] });
    expect((await t.push(b.token, [luis])).body.accepted).toHaveLength(1);

    const inNorte = (await usersIn(b.norteToken)).filter((u) => u.id === luis.aggregateId);
    expect(inNorte.at(-1)).toMatchObject({ isActive: true, role: 'cashier' });
    expect(inNorte.at(-1)?.branchIds).toEqual([b.centro, b.norte].sort());

    const pin = cashier(b.owner, {
      id: luis.aggregateId,
      version: 2,
      branchIds: [b.centro, b.norte],
      pinHash: 'nuevo',
      type: 'user.updated',
    });
    await t.push(b.token, [pin]);
    expect((await usersIn(b.norteToken)).at(-1)).toMatchObject({ pinHash: 'nuevo' });
  });

  it('quitarle una sucursal lo deja inactivo ahí', async () => {
    const b = await twoBranches();
    const luis = cashier(b.owner, { branchIds: [b.centro, b.norte] });
    await t.push(b.token, [luis]);
    await t.push(b.token, [
      cashier(b.owner, {
        id: luis.aggregateId,
        version: 2,
        branchIds: [b.centro],
        type: 'user.updated',
      }),
    ]);
    expect((await usersIn(b.norteToken)).at(-1)).toMatchObject({
      id: luis.aggregateId,
      isActive: false,
    });
  });

  it('un admin no asigna sucursales ni edita a un usuario de varias', async () => {
    const b = await twoBranches();
    const admin = userCreated('admin');
    await t.push(b.token, [admin]);
    const res = await t.push(b.token, [
      cashier(admin.aggregateId, { branchIds: [b.centro, b.norte] }),
    ]);
    expect(res.body.rejected[0].code).toBe('forbidden');

    const luis = cashier(b.owner, { branchIds: [b.centro, b.norte] });
    await t.push(b.token, [luis]);
    const edit = await t.push(b.token, [
      cashier(admin.aggregateId, { id: luis.aggregateId, version: 2, type: 'user.updated' }),
    ]);
    expect(edit.body.rejected[0].code).toBe('forbidden');
  });

  it('ids de otra organización se ignoran; una app vieja no le quita sucursales', async () => {
    const b = await twoBranches();
    const luis = cashier(b.owner, { branchIds: [b.norte, randomUUID()] });
    await t.push(b.token, [luis]);
    const stored = (await usersIn(b.token)).find((u) => u.id === luis.aggregateId);
    expect(stored?.branchIds).toEqual([b.centro, b.norte].sort());

    // Sin `branchIds` (app vieja, sin actor): se conservan.
    await t.push(b.token, [
      cashier(null, { id: luis.aggregateId, version: 2, type: 'user.updated', pinHash: 'x' }),
    ]);
    expect((await usersIn(b.norteToken)).at(-1)).toMatchObject({ pinHash: 'x', isActive: true });
  });
});

describe('mover un equipo a otra sucursal', () => {
  const move = (token: string, userId: string, branchId: string) =>
    request(t.app)
      .post('/v1/org/devices/self/move')
      .set('authorization', `Bearer ${token}`)
      .set('x-boba-user', userId)
      .send({ branchId });

  it('el Dueño lo mueve: baja la otra sucursal y toma una letra libre', async () => {
    const b = await twoBranches();
    await t.push(b.token, [
      envelope('category.upserted', 'category', 'c1', { id: 'c1', name: 'Tés', version: 1 }),
    ]);
    const res = await move(b.token, b.owner, b.norte);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      deviceId: b.deviceId,
      branch: { id: b.norte, name: 'Norte' },
      folioPrefix: 'B', // la A es del iPad Norte
    });

    // Mismo token, ahora de Norte: no ve la categoría de Centro.
    const types = ((await t.pull(b.token)).body.events as { type: string }[]).map((e) => e.type);
    expect(types).not.toContain('category.upserted');
    expect(types).toContain('user.created');
  });

  it('con un turno abierto en este equipo no se mueve', async () => {
    const b = await twoBranches();
    const shift = shiftOpened('s1', { deviceId: b.deviceId });
    await t.push(b.token, [shift]);
    const res = await move(b.token, b.owner, b.norte);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('open_shift');
  });

  it('un admin no mueve equipos; otra organización o la misma sucursal tampoco', async () => {
    const b = await twoBranches();
    const admin = userCreated('admin');
    await t.push(b.token, [admin]);
    expect((await move(b.token, admin.aggregateId, b.norte)).status).toBe(403);

    const other = await twoBranches();
    expect((await move(b.token, b.owner, other.norte)).status).toBe(404);
    expect((await move(b.token, b.owner, b.centro)).body.error.code).toBe('same_branch');
  });
});
