import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  envelope,
  orderCancelled,
  orderCreated,
  setupTestApp,
  userCreated,
} from './helpers.js';

/// Quién hizo cada cambio de usuarios, catálogo e insumos (`actorUserId`).
const t = setupTestApp();

const at = '2026-11-22T15:00:00.000Z';

/// `user.*` hecho por [actor] (o sin actor).
function userEvent(
  type: 'user.created' | 'user.updated',
  role: string,
  actor: string | null,
  { id = randomUUID(), version = 1 }: { id?: string; version?: number } = {},
) {
  return envelope(type, 'user', id, {
    id,
    displayName: role,
    role,
    pinHash: 'h',
    pinSalt: 's',
    isActive: true,
    createdAtUtc: at,
    updatedAtUtc: at,
    version,
    actorUserId: actor,
  });
}

function product(
  actor: string | null,
  {
    version = 1,
    price = 6500,
    soldOut = false,
  }: { version?: number; price?: number; soldOut?: boolean } = {},
) {
  return envelope('product.upserted', 'product', 'p1', {
    id: 'p1',
    name: 'Taro',
    categoryId: 'c1',
    basePriceCents: price,
    isSoldOut: soldOut,
    isActive: true,
    updatedAtUtc: at,
    version,
    actorUserId: actor,
  });
}

/// Equipo con Dueño, admin y cajero ya sincronizados.
async function branchWithStaff() {
  const device = await t.pairedDevice();
  const owner = userCreated('owner');
  const admin = userCreated('admin');
  const cashier = userCreated('cashier');
  await t.push(device.token, [owner, admin, cashier]);
  return {
    ...device,
    owner: owner.aggregateId,
    admin: admin.aggregateId,
    cashier: cashier.aggregateId,
  };
}

const codes = (res: request.Response) => [
  ...(res.body.accepted as unknown[]).map(() => 'ok'),
  ...(res.body.rejected as { code: string }[]).map((r) => r.code),
];

describe('usuarios', () => {
  it('un cajero no da de alta usuarios; un admin sí (no Dueños)', async () => {
    const b = await branchWithStaff();
    expect(
      codes(await t.push(b.token, [userEvent('user.created', 'waiter', b.cashier)])),
    ).toEqual(['forbidden']);
    expect(
      codes(await t.push(b.token, [userEvent('user.created', 'waiter', b.admin)])),
    ).toEqual(['ok']);
    expect(
      codes(await t.push(b.token, [userEvent('user.created', 'owner', b.admin)])),
    ).toEqual(['forbidden']);
  });

  it('un admin no edita ni asciende a un Dueño; el Dueño sí', async () => {
    const b = await branchWithStaff();
    const demote = userEvent('user.updated', 'cashier', b.admin, {
      id: b.owner,
      version: 2,
    });
    const promote = userEvent('user.updated', 'owner', b.admin, {
      id: b.cashier,
      version: 2,
    });
    const res = await t.push(b.token, [demote, promote]);
    expect(codes(res)).toEqual(['forbidden', 'forbidden']);

    const byOwner = userEvent('user.updated', 'owner', b.owner, {
      id: b.cashier,
      version: 2,
    });
    expect(codes(await t.push(b.token, [byOwner]))).toEqual(['ok']);
  });

  it('actor desconocido o inactivo → unknown_user', async () => {
    const b = await branchWithStaff();
    const inactive = userCreated('owner', randomUUID(), false);
    await t.push(b.token, [inactive]);
    const res = await t.push(b.token, [
      userEvent('user.created', 'waiter', randomUUID()),
      userEvent('user.created', 'waiter', inactive.aggregateId),
    ]);
    expect(codes(res)).toEqual(['unknown_user', 'unknown_user']);
  });
});

describe('catálogo e insumos', () => {
  it('un cajero marca agotado pero no cambia el precio', async () => {
    const b = await branchWithStaff();
    expect(codes(await t.push(b.token, [product(b.admin)]))).toEqual(['ok']);

    const soldOut = product(b.cashier, { version: 2, soldOut: true });
    expect(codes(await t.push(b.token, [soldOut]))).toEqual(['ok']);

    const price = product(b.cashier, { version: 3, soldOut: true, price: 100 });
    expect(codes(await t.push(b.token, [price]))).toEqual(['forbidden']);
  });

  it('insumos y categorías exigen sus permisos', async () => {
    const b = await branchWithStaff();
    const supply = (actor: string) =>
      envelope('supply.upserted', 'supply', randomUUID(), {
        id: randomUUID(),
        name: 'Leche',
        unit: 'ml',
        version: 1,
        actorUserId: actor,
      });
    const category = (actor: string) =>
      envelope('category.upserted', 'category', randomUUID(), {
        id: randomUUID(),
        name: 'Tés',
        version: 1,
        actorUserId: actor,
      });
    const res = await t.push(b.token, [
      supply(b.cashier),
      category(b.cashier),
      supply(b.admin),
      category(b.admin),
    ]);
    expect(codes(res)).toEqual(['ok', 'ok', 'forbidden', 'forbidden']);
  });

  it('un cajero actualiza el costo de un insumo (entrada), no lo demás', async () => {
    const b = await branchWithStaff();
    const supply = (
      actor: string,
      version: number,
      extra: Record<string, unknown> = {},
    ) =>
      envelope('supply.upserted', 'supply', 's1', {
        id: 's1',
        name: 'Leche',
        unit: 'ml',
        unitCostCents: 20,
        version,
        actorUserId: actor,
        ...extra,
      });
    expect(codes(await t.push(b.token, [supply(b.admin, 1)]))).toEqual(['ok']);
    expect(
      codes(await t.push(b.token, [supply(b.cashier, 2, { unitCostCents: 25 })])),
    ).toEqual(['ok']);
    expect(
      codes(await t.push(b.token, [supply(b.cashier, 3, { name: 'Agua' })])),
    ).toEqual(['forbidden']);
  });
});

describe('pedidos', () => {
  it('cancelar se valida con quien cancela (o quien lo creó, apps viejas)', async () => {
    const b = await branchWithStaff();
    const kiosk = userCreated('customer');
    await t.push(b.token, [kiosk]);
    const id = randomUUID();
    await t.push(b.token, [orderCreated(id, { createdByUserId: b.cashier })]);

    const byCustomer = orderCancelled(id, {
      createdByUserId: b.cashier,
      cancelledByUserId: kiosk.aggregateId,
    });
    expect(codes(await t.push(b.token, [byCustomer]))).toEqual(['forbidden']);

    const byCashier = orderCancelled(id, {
      createdByUserId: b.cashier,
      cancelledByUserId: b.cashier,
    });
    expect(codes(await t.push(b.token, [byCashier]))).toEqual(['ok']);
  });
});

describe('nombre del negocio', () => {
  it('un admin guarda su sucursal pero no cambia el nombre del negocio', async () => {
    const b = await branchWithStaff();
    const details = (
      userId: string,
      businessName: string,
      branchName: string,
      setAtUtc: string,
    ) =>
      envelope('branch.details_set', 'branch', b.branchId, {
        businessName,
        branchName,
        setAtUtc,
        userId,
      });
    await t.push(b.token, [
      details(b.owner, 'Perlas & Té', 'Centro', '2026-11-22T15:00:00.000Z'),
    ]);
    const res = await t.push(b.token, [
      details(b.admin, 'Otro nombre', 'Norte', '2026-11-22T16:00:00.000Z'),
    ]);
    expect(res.body.accepted).toHaveLength(1);

    const branch = await t.db.branch.findUnique({
      where: { id: b.branchId },
      include: { organization: true },
    });
    expect(branch).toMatchObject({
      name: 'Norte',
      organization: { name: 'Perlas & Té' },
    });
  });
});

describe('sin actor (apps viejas)', () => {
  it('con la bandera apagada se aceptan', async () => {
    const b = await branchWithStaff();
    const second = await t.pairAnother(b.branchId, 'iPad 2');
    const res = await t.push(second.token, [
      userEvent('user.created', 'owner', null),
      product(null),
    ]);
    expect(codes(res)).toEqual(['ok', 'ok']);
  });
});

describe('sin actor con REQUIRE_EVENT_ACTOR', () => {
  const strict = setupTestApp({ requireEventActor: true });

  it('se aceptan al arrancar la sucursal (solo un equipo ha subido)', async () => {
    const first = (await strict.signup()).body as { token: string };
    const res = await strict.push(first.token, [
      userCreated('owner'),
      userCreated('cashier'),
      product(null),
    ]);
    expect(res.body.accepted).toHaveLength(3);
  });

  it('después se rechazan con actor_required (los demás tipos no)', async () => {
    const device = await strict.pairedDevice();
    const owner = userCreated('owner');
    await strict.push(device.token, [owner]);
    const second = await strict.pairAnother(device.branchId, 'iPad 2');

    const res = await strict.push(second.token, [
      userEvent('user.created', 'owner', null),
      product(null),
      product(owner.aggregateId),
    ]);
    expect(codes(res)).toEqual(['ok', 'actor_required', 'actor_required']);
  });
});
