import type { Prisma } from '../../generated/prisma/client.js';
import type { DeviceContext } from '../auth/deviceAuth.js';
import type { PushedEvent } from '../events/schema.js';
import { actorAndPermission, roleCan } from './permissions.js';

export type Tx = Prisma.TransactionClient;
type Payload = Record<string, unknown>;

export type RuleResult =
  | { ok: true; payload: Payload }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

/// Tipos con `version` (last-write-wins) → tipo de agregado en la proyección.
const VERSIONED: Readonly<Record<string, string>> = {
  'category.upserted': 'category',
  'product.upserted': 'product',
  'modifier_group.upserted': 'modifier_group',
  'modifier_option.upserted': 'modifier_option',
  'supply.upserted': 'supply',
  'user.created': 'user',
  'user.updated': 'user',
  'incoming_order.created': 'incoming_order',
  'incoming_order.cancelled': 'incoming_order',
  'shift.opened': 'shift',
  'shift.closed': 'shift',
};

const obj = (v: unknown): Payload | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Payload) : null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const date = (v: unknown): Date | null => {
  const value = str(v);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const rows = (v: unknown): Payload[] =>
  Array.isArray(v) ? v.map(obj).filter((row): row is Payload => row !== null) : [];

/// La fila tal como la guarda la app (el payload sin `v`).
function rowOf(payload: Payload): Payload {
  const row = { ...payload };
  delete row.v;
  return row;
}

export async function stateOf(tx: Tx, branchId: string, aggregateType: string, id: string) {
  return tx.aggregateState.findUnique({
    where: {
      branchId_aggregateType_aggregateId: { branchId, aggregateType, aggregateId: id },
    },
  });
}

/// Turno al que se fusionó `shiftId` (o el mismo si no tiene alias).
async function resolveShift(tx: Tx, branchId: string, shiftId: string): Promise<string> {
  const alias = await tx.shiftAlias.findUnique({
    where: { branchId_fromShiftId: { branchId, fromShiftId: shiftId } },
  });
  return alias?.intoShiftId ?? shiftId;
}

/// Reescribe `shiftId` de turnos fusionados en los registros que lo llevan,
/// para que el dinero nunca se rechace y todos vean el mismo turno.
async function rewriteShiftIds(tx: Tx, branchId: string, type: string, p: Payload) {
  const fix = async (target: Payload | null) => {
    const id = str(target?.shiftId);
    if (target && id) target.shiftId = await resolveShift(tx, branchId, id);
  };
  switch (type) {
    case 'sale.created':
      await fix(obj(p.sale));
      await fix(obj(p.incomingOrder));
      return;
    case 'cash_movement.created':
    case 'supply_movement.created':
    case 'incoming_order.created':
    case 'incoming_order.cancelled':
      await fix(p);
      return;
  }
}

/// Pedido nuevo hecho por el cliente en el kiosco: sin usuario del staff.
function isKioskOrder(type: string, p: Payload): boolean {
  return (
    type === 'incoming_order.created' &&
    p.channel === 'kiosk' &&
    p.status === 'pending' &&
    (p.createdByUserId === null || p.createdByUserId === undefined)
  );
}

const reject = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RuleResult => ({ ok: false, code, message, details });

/// Árbitro de la sucursal: valida un evento contra el estado vigente y lo
/// reescribe si hace falta. Se llama con la sucursal bloqueada (`FOR UPDATE`),
/// en orden, antes de guardar el evento; después se llama a [project].
export async function applyRules(
  tx: Tx,
  device: DeviceContext,
  event: PushedEvent,
): Promise<RuleResult> {
  const branchId = device.branchId;
  const payload = structuredClone(event.payload) as Payload;

  // Modo del dispositivo: siempre sobre el dispositivo del token (el
  // `deviceId` del payload es informativo). Va en el outbox, así que llega en
  // orden respecto a lo que el dispositivo registró antes y después.
  if (event.type === 'device.mode_changed') {
    if (payload.mode !== 'staff' && payload.mode !== 'kiosk') {
      return reject('invalid_event', 'Modo inválido');
    }
    await tx.device.update({ where: { id: device.id }, data: { mode: payload.mode } });
    device.mode = payload.mode;
    return { ok: true, payload };
  }
  // Un kiosco (en manos del cliente) solo puede enviar pedidos de kiosco.
  if (device.mode === 'kiosk' && !isKioskOrder(event.type, payload)) {
    return reject('kiosk_forbidden', 'Un dispositivo en modo kiosco solo envía pedidos');
  }
  await rewriteShiftIds(tx, branchId, event.type, payload);

  // Permisos por rol del actor (si el evento lo trae).
  const required = actorAndPermission(event.type, payload);
  if (required?.actor) {
    const user = await stateOf(tx, branchId, 'user', required.actor);
    const row = obj(user?.row);
    if (!user || row?.isActive === false) {
      return reject('unknown_user', 'Usuario desconocido o inactivo en la sucursal');
    }
    if (!roleCan(user.status ?? '', required.permission)) {
      return reject('forbidden', `El rol ${user.status} no puede ${required.permission}`);
    }
  }

  switch (event.type) {
    case 'shift.opened': {
      const winner = await tx.aggregateState.findFirst({
        where: {
          branchId,
          aggregateType: 'shift',
          status: 'open',
          NOT: { aggregateId: event.aggregateId },
        },
      });
      if (winner) {
        await tx.shiftAlias.upsert({
          where: { branchId_fromShiftId: { branchId, fromShiftId: event.aggregateId } },
          create: { branchId, fromShiftId: event.aggregateId, intoShiftId: winner.aggregateId },
          update: { intoShiftId: winner.aggregateId },
        });
        return reject('shift_conflict', 'Ya hay un turno abierto en la sucursal', {
          winner: winner.row,
        });
      }
      break;
    }
    case 'shift.closed': {
      const into = await resolveShift(tx, branchId, event.aggregateId);
      if (into !== event.aggregateId) {
        const winner = await stateOf(tx, branchId, 'shift', into);
        await tx.syncConflict.create({
          data: {
            branchId,
            kind: 'shift_close_discarded',
            eventId: event.eventId,
            details: { closed: rowOf(payload), mergedInto: into } as Prisma.InputJsonValue,
          },
        });
        return reject('shift_merged', 'El turno se fusionó con el de la sucursal', {
          winner: winner?.row ?? null,
        });
      }
      const current = await stateOf(tx, branchId, 'shift', event.aggregateId);
      if (current?.status === 'closed') {
        return reject('invalid_transition', 'El turno ya estaba cerrado', {
          current: current.row,
          currentType: 'shift',
        });
      }
      break;
    }
    case 'incoming_order.cancelled': {
      const current = await stateOf(tx, branchId, 'incoming_order', event.aggregateId);
      if (current?.status === 'fulfilled' || current?.status === 'cancelled') {
        return reject('invalid_transition', `El pedido ya estaba ${current.status}`, {
          current: current.row,
          currentType: 'incoming_order',
        });
      }
      break;
    }
    case 'sale.created': {
      // Una venta es dinero real: siempre se acepta. El pedido que cumple
      // gana sobre una cancelación; un segundo cobro no lo toca.
      const order = obj(payload.incomingOrder);
      const orderId = str(order?.id);
      if (order && orderId) {
        const current = await stateOf(tx, branchId, 'incoming_order', orderId);
        if (current?.status === 'fulfilled') {
          await tx.syncConflict.create({
            data: {
              branchId,
              kind: 'order_double_charge',
              eventId: event.eventId,
              details: {
                orderId,
                saleId: str(obj(payload.sale)?.id),
                firstSaleId: str(obj(current.row)?.saleId),
              },
            },
          });
          payload.incomingOrder = null;
        } else {
          order.version = Math.max(num(order.version), (current?.version ?? 0) + 1);
        }
      }
      break;
    }
  }

  // Last-write-wins: solo una versión mayor a la vigente (empate: gana el
  // primero que llegó).
  const aggregateType = VERSIONED[event.type];
  if (aggregateType) {
    const current = await stateOf(tx, branchId, aggregateType, event.aggregateId);
    if (current && num(payload.version) <= current.version) {
      return reject('stale_version', 'Hay una versión más nueva en la sucursal', {
        current: current.row,
        currentType: aggregateType,
      });
    }
  }

  return { ok: true, payload };
}

const json = (row: Payload): Prisma.InputJsonValue => row as Prisma.InputJsonValue;
const versionOf = (row: Payload): number => int(row.version) ?? 0;

/// Proyecciones de reportes: se guardan la fila original (`row`) y algunas
/// columnas extraídas. Un payload incompleto no debe tumbar el push; las
/// columnas que falten quedan en `null`.
async function projectCategory(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
  id: string,
) {
  const data = {
    name: str(row.name),
    sortOrder: int(row.sortOrder),
    isActive: bool(row.isActive),
    version: versionOf(row),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchCategory.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectProduct(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
  id: string,
) {
  const data = {
    categoryId: str(row.categoryId),
    name: str(row.name),
    basePriceCents: int(row.basePriceCents),
    sortOrder: int(row.sortOrder),
    isActive: bool(row.isActive),
    imagePath: str(row.imagePath),
    badge: str(row.badge),
    isSoldOut: bool(row.isSoldOut),
    version: versionOf(row),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchProduct.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectModifierGroup(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
  id: string,
) {
  const data = {
    name: str(row.name),
    minSelect: int(row.minSelect),
    maxSelect: int(row.maxSelect),
    sortOrder: int(row.sortOrder),
    version: versionOf(row),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchModifierGroup.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectModifierOption(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
  id: string,
) {
  const data = {
    modifierGroupId: str(row.modifierGroupId),
    name: str(row.name),
    priceDeltaCents: int(row.priceDeltaCents),
    sortOrder: int(row.sortOrder),
    isActive: bool(row.isActive),
    version: versionOf(row),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchModifierOption.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectProductModifierGroup(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
) {
  const productId = str(row.productId);
  const modifierGroupId = str(row.modifierGroupId);
  if (!productId || !modifierGroupId) return;
  const data = {
    sortOrder: int(row.sortOrder),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchProductModifierGroup.upsert({
    where: {
      branchId_productId_modifierGroupId: { branchId, productId, modifierGroupId },
    },
    create: { branchId, productId, modifierGroupId, ...data },
    update: data,
  });
}

async function projectSupply(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
  id: string,
) {
  const data = {
    name: str(row.name),
    category: str(row.category),
    unit: str(row.unit),
    supplierName: str(row.supplierName),
    leadTimeHours: int(row.leadTimeHours),
    minQuantityMilli: int(row.minQuantityMilli),
    unitCostCents: int(row.unitCostCents),
    sortOrder: int(row.sortOrder),
    isActive: bool(row.isActive),
    version: versionOf(row),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchSupply.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectUser(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
  id: string,
) {
  const data = {
    displayName: str(row.displayName),
    role: str(row.role),
    isActive: bool(row.isActive),
    version: versionOf(row),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchUser.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectShift(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
  id: string,
) {
  const data = {
    deviceId: str(row.deviceId),
    openedAtUtc: date(row.openedAtUtc),
    openedBusinessDate: str(row.openedBusinessDate),
    startingCashCents: int(row.startingCashCents),
    closedAtUtc: date(row.closedAtUtc),
    closedBusinessDate: str(row.closedBusinessDate),
    closingCountedCashCents: int(row.closingCountedCashCents),
    closingExpectedCashCents: int(row.closingExpectedCashCents),
    status: str(row.status),
    openedByUserId: str(row.openedByUserId),
    closedByUserId: str(row.closedByUserId),
    version: versionOf(row),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchShift.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectSale(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
  id: string,
) {
  const data = {
    shiftId: str(row.shiftId),
    deviceId: str(row.deviceId),
    businessDate: str(row.businessDate),
    subtotalCents: int(row.subtotalCents),
    discountCents: int(row.discountCents),
    taxCents: int(row.taxCents),
    totalCents: int(row.totalCents),
    currencyCode: str(row.currencyCode),
    channel: str(row.channel),
    userId: str(row.userId),
    createdAtUtc: date(row.createdAtUtc),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchSale.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectSaleItem(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
) {
  const id = str(row.id);
  const saleId = str(row.saleId);
  if (!id || !saleId) return;
  const data = {
    saleId,
    productId: str(row.productId),
    productNameSnapshot: str(row.productNameSnapshot),
    unitPriceCentsSnapshot: int(row.unitPriceCentsSnapshot),
    quantity: int(row.quantity),
    lineTotalCents: int(row.lineTotalCents),
    createdAtUtc: date(row.createdAtUtc),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchSaleItem.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectSaleItemModifier(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
) {
  const id = str(row.id);
  const saleItemId = str(row.saleItemId);
  if (!id || !saleItemId) return;
  const data = {
    saleItemId,
    modifierOptionId: str(row.modifierOptionId),
    modifierGroupNameSnapshot: str(row.modifierGroupNameSnapshot),
    modifierOptionNameSnapshot: str(row.modifierOptionNameSnapshot),
    priceDeltaCentsSnapshot: int(row.priceDeltaCentsSnapshot),
    createdAtUtc: date(row.createdAtUtc),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchSaleItemModifier.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectPayment(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
) {
  const id = str(row.id);
  const saleId = str(row.saleId);
  if (!id || !saleId) return;
  const data = {
    saleId,
    method: str(row.method),
    amountCents: int(row.amountCents),
    tenderedCents: int(row.tenderedCents),
    changeCents: int(row.changeCents),
    createdAtUtc: date(row.createdAtUtc),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchPayment.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectCashMovement(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
  id: string,
) {
  const data = {
    shiftId: str(row.shiftId),
    deviceId: str(row.deviceId),
    businessDate: str(row.businessDate),
    kind: str(row.kind),
    category: str(row.category),
    concept: str(row.concept),
    amountCents: int(row.amountCents),
    counterparty: str(row.counterparty),
    userId: str(row.userId),
    createdAtUtc: date(row.createdAtUtc),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchCashMovement.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectSupplyMovement(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
  id: string,
) {
  const data = {
    supplyId: str(row.supplyId) ?? '',
    kind: str(row.kind),
    quantityDeltaMilli: int(row.quantityDeltaMilli),
    unitCostCents: int(row.unitCostCents),
    note: str(row.note),
    userId: str(row.userId),
    shiftId: str(row.shiftId),
    deviceId: str(row.deviceId),
    businessDate: str(row.businessDate),
    createdAtUtc: date(row.createdAtUtc),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchSupplyMovement.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

async function projectIncomingOrder(
  tx: Tx,
  branchId: string,
  seq: bigint,
  row: Payload,
  id: string,
) {
  const data = {
    channel: str(row.channel),
    customerName: str(row.customerName),
    pickupAtUtc: date(row.pickupAtUtc),
    status: str(row.status),
    saleId: str(row.saleId),
    deviceId: str(row.deviceId),
    shiftId: str(row.shiftId),
    createdByUserId: str(row.createdByUserId),
    createdAtUtc: date(row.createdAtUtc),
    updatedAtUtc: date(row.updatedAtUtc),
    version: versionOf(row),
    row: json(row),
    lastServerSeq: seq,
  };
  await tx.branchIncomingOrder.upsert({
    where: { branchId_id: { branchId, id } },
    create: { branchId, id, ...data },
    update: data,
  });
}

/// Actualiza las proyecciones con un evento ya guardado (también la usa
/// [rebuildProjections]).
export async function project(
  tx: Tx,
  branchId: string,
  type: string,
  aggregateId: string,
  payload: Payload,
  serverSeq: bigint,
): Promise<void> {
  const upsert = async (aggregateType: string, id: string, row: Payload) => {
    const data = {
      version: num(row.version),
      status: str(aggregateType === 'user' ? row.role : row.status),
      row: json(row),
      lastServerSeq: serverSeq,
    };
    await tx.aggregateState.upsert({
      where: {
        branchId_aggregateType_aggregateId: { branchId, aggregateType, aggregateId: id },
      },
      create: { branchId, aggregateType, aggregateId: id, ...data },
      update: data,
    });
  };

  const row = rowOf(payload);
  const id = str(row.id) ?? aggregateId;
  const aggregateType = VERSIONED[type];
  if (aggregateType) await upsert(aggregateType, aggregateId, row);

  switch (type) {
    case 'category.upserted':
      await projectCategory(tx, branchId, serverSeq, row, id);
      break;
    case 'product.upserted':
      await projectProduct(tx, branchId, serverSeq, row, id);
      break;
    case 'modifier_group.upserted':
      await projectModifierGroup(tx, branchId, serverSeq, row, id);
      break;
    case 'modifier_option.upserted':
      await projectModifierOption(tx, branchId, serverSeq, row, id);
      break;
    case 'product_modifier_group.upserted':
      await projectProductModifierGroup(tx, branchId, serverSeq, row);
      break;
    case 'supply.upserted':
      await projectSupply(tx, branchId, serverSeq, row, id);
      break;
    case 'user.created':
    case 'user.updated':
      await projectUser(tx, branchId, serverSeq, row, id);
      break;
    case 'shift.opened':
    case 'shift.closed':
      await projectShift(tx, branchId, serverSeq, row, id);
      break;
    case 'incoming_order.created':
    case 'incoming_order.cancelled':
      await projectIncomingOrder(tx, branchId, serverSeq, row, id);
      break;
    case 'sale.created': {
      const sale = obj(payload.sale);
      if (sale) await projectSale(tx, branchId, serverSeq, sale, str(sale.id) ?? aggregateId);
      for (const item of rows(payload.items)) {
        await projectSaleItem(tx, branchId, serverSeq, item);
      }
      for (const modifier of rows(payload.modifiers)) {
        await projectSaleItemModifier(tx, branchId, serverSeq, modifier);
      }
      for (const payment of rows(payload.payments)) {
        await projectPayment(tx, branchId, serverSeq, payment);
      }
      const order = obj(payload.incomingOrder);
      const orderId = str(order?.id);
      if (order && orderId) {
        await upsert('incoming_order', orderId, order);
        await projectIncomingOrder(tx, branchId, serverSeq, order, orderId);
      }
      break;
    }
    case 'cash_movement.created':
      await projectCashMovement(tx, branchId, serverSeq, row, id);
      break;
    case 'supply_movement.created':
      await projectSupplyMovement(tx, branchId, serverSeq, row, id);
      break;
    case 'device.mode_changed':
      break;
  }
}

/// Reconstruye las proyecciones desde `events` (sin arbitrar: los eventos
/// guardados ya pasaron las reglas). Los alias de turno no se reconstruyen:
/// son decisiones del árbitro, no derivables del log.
export async function rebuildProjections(
  db: { $transaction: <T>(fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }) => Promise<T> },
  branchId?: string,
): Promise<number> {
  const where = branchId ? { branchId } : {};
  return db.$transaction(
    async (tx) => {
      await tx.aggregateState.deleteMany({ where });
      await tx.branchCategory.deleteMany({ where });
      await tx.branchProduct.deleteMany({ where });
      await tx.branchModifierGroup.deleteMany({ where });
      await tx.branchModifierOption.deleteMany({ where });
      await tx.branchProductModifierGroup.deleteMany({ where });
      await tx.branchSupply.deleteMany({ where });
      await tx.branchUser.deleteMany({ where });
      await tx.branchShift.deleteMany({ where });
      await tx.branchSale.deleteMany({ where });
      await tx.branchSaleItem.deleteMany({ where });
      await tx.branchSaleItemModifier.deleteMany({ where });
      await tx.branchPayment.deleteMany({ where });
      await tx.branchCashMovement.deleteMany({ where });
      await tx.branchSupplyMovement.deleteMany({ where });
      await tx.branchIncomingOrder.deleteMany({ where });
      let count = 0;
      let after = 0n;
      for (;;) {
        const page = await tx.event.findMany({
          where: { serverSeq: { gt: after }, ...(branchId ? { branchId } : {}) },
          orderBy: { serverSeq: 'asc' },
          take: 1000,
        });
        if (page.length === 0) break;
        for (const e of page) {
          await project(tx, e.branchId, e.type, e.aggregateId, e.payload as Payload, e.serverSeq);
          count++;
        }
        after = page.at(-1)!.serverSeq;
      }
      return count;
    },
    { timeout: 120_000 },
  );
}
