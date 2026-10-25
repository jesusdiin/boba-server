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

/// La fila tal como la guarda la app (el payload sin `v`).
function rowOf(payload: Payload): Payload {
  const row = { ...payload };
  delete row.v;
  return row;
}

async function stateOf(tx: Tx, branchId: string, aggregateType: string, id: string) {
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
      row: row as Prisma.InputJsonValue,
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

  const aggregateType = VERSIONED[type];
  if (aggregateType) return upsert(aggregateType, aggregateId, rowOf(payload));
  if (type === 'sale.created') {
    const order = obj(payload.incomingOrder);
    const id = str(order?.id);
    if (order && id) await upsert('incoming_order', id, order);
  }
}

/// Reconstruye `aggregate_state` desde `events` (sin arbitrar: los eventos
/// guardados ya pasaron las reglas). Los alias de turno no se reconstruyen:
/// son decisiones del árbitro, no derivables del log.
export async function rebuildProjections(
  db: { $transaction: <T>(fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }) => Promise<T> },
  branchId?: string,
): Promise<number> {
  return db.$transaction(
    async (tx) => {
      await tx.aggregateState.deleteMany({ where: branchId ? { branchId } : {} });
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
