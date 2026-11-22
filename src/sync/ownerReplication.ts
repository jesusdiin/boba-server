import type { Db } from '../db.js';
import type { BranchNotifier } from '../realtime/branchNotifier.js';
import { derivedEventId, insertEvent } from './events.js';
import { stateOf, type Tx } from './rules.js';

type Payload = Record<string, unknown> & { v: number };

/// El Dueño es de la organización: existe en todas sus sucursales con el
/// mismo id y PIN. Cada `user.*` de un Dueño (o que deja de serlo) aceptado
/// en una sucursal se copia a las demás.
///
/// Corre después del commit del push, una transacción por sucursal destino
/// (bloquea solo esa sucursal: no hay deadlocks entre sucursales). Los
/// `eventId` de las copias son deterministas, así reintentar no duplica.
export async function replicateToOrganization(
  db: Db,
  notifier: BranchNotifier,
  sourceBranchId: string,
  events: { eventId: string }[],
): Promise<void> {
  const source = await db.branch.findUnique({ where: { id: sourceBranchId } });
  if (!source) return;
  const targets = await db.branch.findMany({
    where: { organizationId: source.organizationId, NOT: { id: sourceBranchId } },
    select: { id: true },
  });
  if (targets.length === 0) return;
  const originals = await db.event.findMany({
    where: { eventId: { in: events.map((e) => e.eventId) } },
    orderBy: { serverSeq: 'asc' },
  });

  for (const { id: branchId } of targets) {
    const last = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM branches WHERE id = ${branchId}::uuid FOR UPDATE`;
      let seq: bigint | null = null;
      for (const e of originals) {
        const payload = structuredClone(e.payload) as Payload;
        // Dejó de ser Dueño: en las otras sucursales ya no entra.
        if (payload.role !== 'owner') payload.isActive = false;
        seq =
          (await copyUserEvent(tx, {
            eventId: derivedEventId(e.eventId, branchId),
            organizationId: e.organizationId,
            branchId,
            deviceId: e.deviceId,
            type: e.type,
            aggregateId: e.aggregateId,
            payload,
            createdAt: e.deviceCreatedAt,
          })) ?? seq;
      }
      return seq;
    });
    if (last !== null) notifier.notify(branchId, last);
  }
}

/// Copia un `user.*` si es más nuevo que lo que hay en la sucursal (LWW por
/// versión, como el árbitro). `null` si ya estaba o es viejo.
async function copyUserEvent(
  tx: Tx,
  e: {
    eventId: string;
    organizationId: string;
    branchId: string;
    deviceId: string;
    type: string;
    aggregateId: string;
    payload: Payload;
    createdAt: Date;
  },
): Promise<bigint | null> {
  const exists = await tx.event.findUnique({ where: { eventId: e.eventId }, select: { eventId: true } });
  if (exists) return null;
  const current = await stateOf(tx, e.branchId, 'user', e.aggregateId);
  if (current && Number(e.payload.version) <= current.version) return null;
  return insertEvent(tx, { ...e, aggregateType: 'user' });
}

/// Da de alta en [branchId] a los Dueños vigentes de la organización (los
/// que falten o tengan una versión vieja). Para sucursales nuevas y para la
/// migración de admins. Los eventos quedan a nombre de [deviceId].
export async function syncOwnersInto(
  tx: Tx,
  organizationId: string,
  branchId: string,
  deviceId: string,
  createdAt = new Date(),
): Promise<bigint | null> {
  const states = await tx.aggregateState.findMany({
    where: {
      aggregateType: 'user',
      status: 'owner',
      branch: { organizationId },
      NOT: { branchId },
    },
  });
  // La versión más nueva de cada Dueño (puede estar en varias sucursales).
  const latest = new Map<string, (typeof states)[number]>();
  for (const s of states) {
    const seen = latest.get(s.aggregateId);
    if (!seen || s.version > seen.version) latest.set(s.aggregateId, s);
  }
  let last: bigint | null = null;
  for (const s of latest.values()) {
    const row = s.row as Record<string, unknown>;
    if (row.isActive === false) continue;
    const current = await stateOf(tx, branchId, 'user', s.aggregateId);
    last =
      (await copyUserEvent(tx, {
        eventId: derivedEventId('owner', s.aggregateId, String(s.version), branchId),
        organizationId,
        branchId,
        deviceId,
        type: current ? 'user.updated' : 'user.created',
        aggregateId: s.aggregateId,
        payload: { ...row, v: 1 },
        createdAt,
      })) ?? last;
  }
  return last;
}

/// Migración al rol Dueño: cada admin activo pasa a `owner` (un
/// `user.updated` con versión+1 en su sucursal) y se replica a las demás
/// sucursales de su organización. Idempotente: un admin ya promovido no
/// vuelve a aparecer. Correr cuando todos los equipos ya tengan la app que
/// conoce el rol.
export async function promoteAdminsToOwners(
  db: Db,
  notifier: BranchNotifier,
  organizationId?: string,
): Promise<{ promoted: number }> {
  const branches = await db.branch.findMany({
    where: organizationId ? { organizationId } : {},
    select: { id: true, organizationId: true },
  });
  let promoted = 0;
  for (const branch of branches) {
    const done = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM branches WHERE id = ${branch.id}::uuid FOR UPDATE`;
      const admins = await tx.aggregateState.findMany({
        where: { branchId: branch.id, aggregateType: 'user', status: 'admin' },
      });
      const device = await tx.device.findFirst({
        where: { branchId: branch.id },
        orderBy: { createdAt: 'asc' },
      });
      if (!device) return { eventIds: [] as string[], last: null as bigint | null };
      const eventIds: string[] = [];
      let last: bigint | null = null;
      const now = new Date();
      for (const admin of admins) {
        const row = admin.row as Record<string, unknown>;
        if (row.isActive === false) continue;
        const version = admin.version + 1;
        const eventId = derivedEventId('promote-owner', branch.id, admin.aggregateId, String(version));
        last = await insertEvent(tx, {
          eventId,
          organizationId: branch.organizationId,
          branchId: branch.id,
          deviceId: device.id,
          type: 'user.updated',
          aggregateType: 'user',
          aggregateId: admin.aggregateId,
          payload: { ...row, role: 'owner', version, updatedAtUtc: now.toISOString(), v: 1 },
          createdAt: now,
        });
        eventIds.push(eventId);
      }
      return { eventIds, last };
    });
    if (done.last !== null) notifier.notify(branch.id, done.last);
    if (done.eventIds.length > 0) {
      await replicateToOrganization(
        db,
        notifier,
        branch.id,
        done.eventIds.map((eventId) => ({ eventId })),
      );
      promoted += done.eventIds.length;
    }
  }
  return { promoted };
}
