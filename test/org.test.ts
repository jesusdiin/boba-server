import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { roleCan } from '../src/sync/permissions.js';
import { envelope, productUpserted, setupTestApp, userCreated } from './helpers.js';

const t = setupTestApp();

/// Negocio registrado desde la app con su Dueño (y opcionalmente en Max).
async function business(opts: { plan?: 'pro' | 'max' } = {}) {
  const device = (await t.signup()).body as {
    deviceId: string;
    token: string;
    organizationId: string;
    branch: { id: string };
  };
  if (opts.plan === 'max') {
    await t.admin().patch(`/organizations/${device.organizationId}/plan`, {
      plan: 'max',
      subscriptionStatus: 'active',
      currentPeriodEnd: null,
    });
  }
  const owner = userCreated('owner');
  await t.push(device.token, [owner]);
  return { ...device, ownerId: owner.aggregateId, owner };
}

const org = (token: string, userId?: string) => {
  const auth = (r: request.Test) => {
    r.set('authorization', `Bearer ${token}`);
    return userId ? r.set('x-boba-user', userId) : r;
  };
  return {
    get: (path: string) => auth(request(t.app).get(`/v1/org${path}`)),
    post: (path: string, body?: object) => auth(request(t.app).post(`/v1/org${path}`)).send(body),
  };
};

/// Empareja un equipo con el código y devuelve su token.
async function pairWith(code: string, deviceName = 'iPad Norte') {
  const res = await request(t.app).post('/v1/devices/pair').send({ code, deviceName });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

const usersIn = async (token: string) =>
  ((await t.pull(token)).body.events as { type: string; payload: Record<string, unknown> }[])
    .filter((e) => e.type.startsWith('user.'))
    .map((e) => e.payload);

describe('roles', () => {
  it('el Dueño puede todo; el Admin todo menos la organización', () => {
    expect(roleCan('owner', 'manageOrganization')).toBe(true);
    expect(roleCan('owner', 'manageDevices')).toBe(true);
    expect(roleCan('admin', 'manageOrganization')).toBe(false);
    expect(roleCan('admin', 'manageUsers')).toBe(true);
    expect(roleCan('cashier', 'manageOrganization')).toBe(false);
  });
});

describe('sucursales desde la app (/v1/org)', () => {
  it('solo el Dueño; un Admin recibe 403', async () => {
    const a = await business({ plan: 'max' });
    const admin = userCreated('admin');
    await t.push(a.token, [admin]);

    expect((await org(a.token, admin.aggregateId).get('/branches')).status).toBe(403);
    const list = await org(a.token, a.ownerId).get('/branches');
    expect(list.status).toBe(200);
    expect(list.body.branches).toEqual([
      expect.objectContaining({ name: 'Principal', devices: 1, current: true }),
    ]);
  });

  it('Pro tiene una sucursal: la segunda es plan_limit', async () => {
    const a = await business();
    const res = await org(a.token, a.ownerId).post('/branches', { name: 'Norte' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('plan_limit');
  });

  it('crea la sucursal con los Dueños y el catálogo; el equipo nuevo los recibe', async () => {
    const a = await business({ plan: 'max' });
    const cashier = userCreated('cashier');
    await t.push(a.token, [
      cashier,
      envelope('category.upserted', 'category', 'c1', { id: 'c1', name: 'Tés', version: 1 }),
      productUpserted('p1', 3, 'Taro'),
    ]);

    const res = await org(a.token, a.ownerId).post('/branches', { name: 'Norte' });
    expect(res.status).toBe(201);
    expect(res.body.branch.name).toBe('Norte');

    const norte = await pairWith(res.body.pairingCode.code);
    const events = (await t.pull(norte)).body.events as {
      type: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    }[];
    // El Dueño sí, el cajero no (es de la otra sucursal).
    expect(events.filter((e) => e.type.startsWith('user.')).map((e) => e.aggregateId)).toEqual([
      a.ownerId,
    ]);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['category.upserted', 'product.upserted']),
    );
    expect(events.find((e) => e.type === 'product.upserted')?.payload).toMatchObject({
      id: 'p1',
      name: 'Taro',
    });

    const list = await org(a.token, a.ownerId).get('/branches');
    expect(list.body.branches.map((b: { name: string }) => b.name)).toEqual(['Principal', 'Norte']);
  });

  it('sin catálogo solo llegan los Dueños', async () => {
    const a = await business({ plan: 'max' });
    await t.push(a.token, [productUpserted('p1', 1, 'Taro')]);
    const res = await org(a.token, a.ownerId).post('/branches', {
      name: 'Norte',
      copyCatalog: false,
    });
    const norte = await pairWith(res.body.pairingCode.code);
    const types = ((await t.pull(norte)).body.events as { type: string }[]).map((e) => e.type);
    expect(types).toEqual(['user.created']);
  });

  it('el Dueño saca códigos para cualquier sucursal de su organización', async () => {
    const a = await business({ plan: 'max' });
    const created = await org(a.token, a.ownerId).post('/branches', { name: 'Norte' });
    const code = await org(a.token, a.ownerId).post(`/branches/${created.body.branch.id}/pairing-codes`);
    expect(code.status).toBe(201);
    await pairWith(code.body.code, 'Otro iPad Norte');

    const other = await business({ plan: 'max' });
    const foreign = await org(other.token, other.ownerId).post(
      `/branches/${created.body.branch.id}/pairing-codes`,
    );
    expect(foreign.status).toBe(404);
  });
});

describe('el Dueño en todas las sucursales', () => {
  it('un cambio del Dueño en una sucursal llega a las demás', async () => {
    const a = await business({ plan: 'max' });
    const created = await org(a.token, a.ownerId).post('/branches', { name: 'Norte' });
    const norte = await pairWith(created.body.pairingCode.code);

    const newPin = {
      ...a.owner,
      eventId: crypto.randomUUID(),
      type: 'user.updated',
      payload: { ...a.owner.payload, pinHash: 'nuevo', version: 2 },
    };
    expect((await t.push(a.token, [newPin])).body.accepted).toHaveLength(1);

    const inNorte = await usersIn(norte);
    expect(inNorte.at(-1)).toMatchObject({ id: a.ownerId, pinHash: 'nuevo', version: 2 });

    // Un Dueño creado en Norte también aparece en Principal.
    const second = userCreated('owner');
    await t.push(norte, [second]);
    expect((await usersIn(a.token)).map((u) => u.id)).toContain(second.aggregateId);
  });

  it('si deja de ser Dueño, en las otras sucursales queda inactivo', async () => {
    const a = await business({ plan: 'max' });
    const created = await org(a.token, a.ownerId).post('/branches', { name: 'Norte' });
    const norte = await pairWith(created.body.pairingCode.code);

    await t.push(a.token, [
      {
        ...a.owner,
        eventId: crypto.randomUUID(),
        type: 'user.updated',
        payload: { ...a.owner.payload, role: 'admin', version: 2 },
      },
    ]);
    expect((await usersIn(norte)).at(-1)).toMatchObject({
      id: a.ownerId,
      role: 'admin',
      isActive: false,
    });
  });

  it('promote-admins: los admins pasan a Dueño y se replican', async () => {
    const a = await business({ plan: 'max' });
    const admin = userCreated('admin');
    await t.push(a.token, [admin]);
    const created = await org(a.token, a.ownerId).post('/branches', { name: 'Norte' });
    const norte = await pairWith(created.body.pairingCode.code);

    const res = await t.admin().post('/users/promote-admins', { organizationId: a.organizationId });
    expect(res.body).toEqual({ promoted: 1 });
    expect((await usersIn(a.token)).at(-1)).toMatchObject({ id: admin.aggregateId, role: 'owner' });
    expect((await usersIn(norte)).at(-1)).toMatchObject({ id: admin.aggregateId, role: 'owner' });

    // Idempotente.
    expect((await t.admin().post('/users/promote-admins', {})).body).toEqual({ promoted: 0 });
  });
});
