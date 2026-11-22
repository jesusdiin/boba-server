import type { Prisma } from '../../generated/prisma/client.js';
import type { DeviceContext } from '../auth/deviceAuth.js';
import type { PushedEvent } from '../events/schema.js';
import { ACTOR_REQUIRED_TYPES, actorAndPermission, roleCan } from './permissions.js';

export type Tx = Prisma.TransactionClient;
type Payload = Record<string, unknown>;

export interface RuleOptions {
  /// `REQUIRE_EVENT_ACTOR`: rechazar cambios de usuarios/catálogo/insumos
  /// sin actor (salvo al arrancar la sucursal).
  requireActor?: boolean;
}

export type RuleResult =
  | {
      ok: true;
      payload: Payload;
      /// Evento de un Dueño (o que deja de serlo): se copia a las demás
      /// sucursales de la organización (`ownerReplication.ts`).
      replicateToOrg?: boolean;
    }
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
  'incoming_order.prep_changed': 'incoming_order',
  'shift.opened': 'shift',
  'shift.closed': 'shift',
};

/// Temas de la app (`AppThemeId` en boba_pos/lib/core/theme/app_themes.dart).
const THEMES: ReadonlySet<string> = new Set(['boba', 'minimal', 'dark']);

/// Tipografías (`AppFontId` en boba_pos/lib/core/theme/app_fonts.dart).
const FONTS: ReadonlySet<string> = new Set(['classic', 'editorial', 'modern']);

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
      // v3: el consumo de insumos va en el mismo turno que la venta.
      for (const movement of rows(p.supplyMovements)) await fix(movement);
      return;
    case 'cash_movement.created':
    case 'supply_movement.created':
    case 'incoming_order.created':
    case 'incoming_order.cancelled':
    case 'incoming_order.prep_changed':
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
  options: RuleOptions = {},
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
  if (event.type === 'branch.details_set') {
    const name = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 80;
    const optional = (v: unknown) => v == null || (typeof v === 'string' && v.length <= 200);
    if (
      !name(payload.businessName) ||
      !name(payload.branchName) ||
      !['address', 'phone', 'whatsapp', 'instagram'].every((k) => optional(payload[k])) ||
      Number.isNaN(Date.parse(String(payload.setAtUtc)))
    ) {
      return reject('invalid_event', 'Datos del negocio inválidos');
    }
  }
  if (event.type === 'branch.theme_set') {
    if (!THEMES.has(String(payload.theme)) || typeof payload.automatic !== 'boolean') {
      return reject('invalid_event', 'Tema inválido');
    }
    // `font` es opcional (null = la tipografía del tema).
    if (payload.font != null && !FONTS.has(String(payload.font))) {
      return reject('invalid_event', 'Tipografía inválida');
    }
  }
  await rewriteShiftIds(tx, branchId, event.type, payload);
  if (event.type === 'user.created' || event.type === 'user.updated') {
    await normalizeBranchIds(tx, device, event.aggregateId, payload);
  }

  // Permisos por rol del actor (si el evento lo trae).
  const required = actorAndPermission(event.type, payload);
  if (required?.actor) {
    const user = await stateOf(tx, branchId, 'user', required.actor);
    const row = obj(user?.row);
    if (!user || row?.isActive === false) {
      return reject('unknown_user', 'Usuario desconocido o inactivo en la sucursal');
    }
    const role = user.status ?? '';
    // Lo que hace la caja sin ser admin: marcar agotado un producto, o el
    // costo nuevo de un insumo al registrar una entrada.
    let permission = required.permission;
    if (
      event.type === 'product.upserted' &&
      (await onlyChanged(tx, branchId, 'product', event.aggregateId, payload, 'isSoldOut'))
    ) {
      permission = 'markSoldOut';
    } else if (
      event.type === 'supply.upserted' &&
      (await onlyChanged(tx, branchId, 'supply', event.aggregateId, payload, 'unitCostCents'))
    ) {
      permission = 'inventoryEntries';
    }
    if (!roleCan(role, permission)) {
      return reject('forbidden', `El rol ${role} no puede ${permission}`);
    }
    // Un Dueño solo lo crea, edita o asciende otro Dueño; también es el único
    // que asigna sucursales o edita a un usuario de varias sucursales.
    if (event.type === 'user.created' || event.type === 'user.updated') {
      const target = await stateOf(tx, branchId, 'user', event.aggregateId);
      const touchesOwner = payload.role === 'owner' || target?.status === 'owner';
      if (touchesOwner && role !== 'owner') {
        return reject('forbidden', 'Solo un Dueño puede asignar o cambiar a un Dueño');
      }
      const before = branchIdsOf(obj(target?.row)?.branchIds);
      const after = branchIdsOf(payload.branchIds ?? obj(target?.row)?.branchIds);
      const multi = before.length > 1 || after.length > 1;
      if (multi && role !== 'owner') {
        return reject('forbidden', 'Solo un Dueño edita a un usuario de varias sucursales');
      }
    }
    // El nombre del negocio es de la organización: solo el Dueño lo cambia
    // (de un Admin se conserva el vigente; sus datos de sucursal sí pasan).
    if (event.type === 'branch.details_set' && !roleCan(role, 'manageOrganization')) {
      const org = await tx.organization.findUnique({
        where: { id: device.organizationId },
        select: { name: true },
      });
      if (org) payload.businessName = org.name;
    }
  } else if (
    required &&
    options.requireActor &&
    ACTOR_REQUIRED_TYPES.has(event.type) &&
    !(await isBranchBootstrap(tx, device))
  ) {
    return reject('actor_required', 'El cambio no dice qué usuario lo hizo; actualiza la app');
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
    case 'incoming_order.cancelled':
    case 'incoming_order.prep_changed': {
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
    // Dueño (o deja de serlo), o usuario de varias sucursales (o deja de
    // serlo): se copia a las demás (`ownerReplication.ts`).
    if (
      aggregateType === 'user' &&
      (payload.role === 'owner' ||
        current?.status === 'owner' ||
        branchIdsOf(payload.branchIds).length > 1 ||
        branchIdsOf(obj(current?.row)?.branchIds).length > 1)
    ) {
      return { ok: true, payload, replicateToOrg: true };
    }
  }

  return { ok: true, payload };
}

/// Sucursales de un usuario (`branchIds`): lista de ids, o el mismo JSON en
/// texto. Vacío = solo la sucursal donde está.
export function branchIdsOf(value: unknown): string[] {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
}

/// Deja `branchIds` en sucursales de la organización, con la de origen
/// incluida (`null` si solo es esa). Una app vieja no manda el campo: se
/// conservan las sucursales vigentes para no quitárselas sin querer.
async function normalizeBranchIds(
  tx: Tx,
  device: DeviceContext,
  userId: string,
  payload: Payload,
): Promise<void> {
  if (!('branchIds' in payload)) {
    const current = await stateOf(tx, device.branchId, 'user', userId);
    const kept = branchIdsOf(obj(current?.row)?.branchIds);
    if (kept.length > 1) payload.branchIds = kept;
    return;
  }
  const wanted = branchIdsOf(payload.branchIds);
  if (wanted.length === 0) {
    payload.branchIds = null;
    return;
  }
  const ours = new Set(
    (
      await tx.branch.findMany({
        where: { organizationId: device.organizationId },
        select: { id: true },
      })
    ).map((b) => b.id),
  );
  const ids = [...new Set([device.branchId, ...wanted])].filter((id) => ours.has(id)).sort();
  payload.branchIds = ids.length > 1 ? ids : null;
}

/// Arranque de la sucursal: ningún otro equipo ha subido eventos (registro,
/// configuración inicial y la republicación del primer equipo no tienen
/// sesión). Una sucursal creada desde `/v1/org` nace con eventos del equipo
/// que la creó, así que no entra aquí.
async function isBranchBootstrap(tx: Tx, device: DeviceContext): Promise<boolean> {
  const other = await tx.event.findFirst({
    where: { branchId: device.branchId, NOT: { deviceId: device.id } },
    select: { eventId: true },
  });
  return other === null;
}

/// Respecto de la fila vigente solo cambia [field] (sin contar versión,
/// fecha de cambio ni actor). Sin fila vigente (alta) → `false`.
async function onlyChanged(
  tx: Tx,
  branchId: string,
  aggregateType: string,
  id: string,
  payload: Payload,
  field: string,
): Promise<boolean> {
  const current = await stateOf(tx, branchId, aggregateType, id);
  const before = obj(current?.row);
  if (!before) return false;
  const ignored = new Set(['v', 'version', 'updatedAtUtc', 'actorUserId', field]);
  const keys = new Set([...Object.keys(before), ...Object.keys(payload)]);
  for (const key of keys) {
    if (ignored.has(key)) continue;
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(payload[key] ?? null)) {
      return false;
    }
  }
  return true;
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

/// Quitar un grupo de un producto: borra la unión (idempotente).
async function removeProductModifierGroup(tx: Tx, branchId: string, row: Payload) {
  const productId = str(row.productId);
  const modifierGroupId = str(row.modifierGroupId);
  if (!productId || !modifierGroupId) return;
  await tx.branchProductModifierGroup.deleteMany({
    where: { branchId, productId, modifierGroupId },
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
    case 'product_modifier_group.removed':
      await removeProductModifierGroup(tx, branchId, row);
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
    case 'incoming_order.prep_changed':
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
      // v3: consumo de insumos según las recetas (movimientos `sale`).
      for (const movement of rows(payload.supplyMovements)) {
        const movementId = str(movement.id);
        if (movementId) {
          await projectSupplyMovement(tx, branchId, serverSeq, movement, movementId);
        }
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
    case 'branch.details_set':
      await projectBranchDetails(tx, branchId, payload);
      break;
    case 'device.mode_changed':
    case 'branch.theme_set':
      break;
  }
}

/// Nombre del negocio y datos de la sucursal: solo si es más nuevo que lo
/// aplicado (los equipos pueden subir fuera de orden).
async function projectBranchDetails(tx: Tx, branchId: string, p: Payload) {
  const setAt = new Date(String(p.setAtUtc));
  const branch = await tx.branch.findUnique({ where: { id: branchId } });
  if (!branch || (branch.detailsSetAt && setAt <= branch.detailsSetAt)) return;
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  await tx.branch.update({
    where: { id: branchId },
    data: {
      name: String(p.branchName).trim(),
      address: text(p.address),
      phone: text(p.phone),
      whatsapp: text(p.whatsapp),
      instagram: text(p.instagram),
      detailsSetAt: setAt,
    },
  });
  await tx.organization.update({
    where: { id: branch.organizationId },
    data: { name: String(p.businessName).trim() },
  });
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
