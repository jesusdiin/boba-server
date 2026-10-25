import { Router } from 'express';
import { z } from 'zod';

import { requireDevice } from '../auth/deviceAuth.js';
import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import type { BranchNotifier } from '../realtime/branchNotifier.js';
import { actorAndPermission } from '../sync/permissions.js';
import { applyRules, project } from '../sync/rules.js';
import {
  eventRejection,
  MAX_PUSH_BATCH,
  PushBody,
  PushedEvent,
} from '../events/schema.js';

const PullQuery = z.object({
  after: z
    .string()
    .regex(/^\d+$/, 'after debe ser un entero ≥ 0')
    .default('0')
    .transform((s) => BigInt(s)),
  limit: z.coerce.number().int().min(1).max(MAX_PUSH_BATCH).default(200),
});

type Rejected = {
  eventId: string | null;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

/// Actor del evento (auditoría), si lo trae.
const userIdOf = (type: string, payload: Record<string, unknown>): string | null =>
  actorAndPermission(type, payload)?.actor ?? null;

export function syncRouter(db: Db, notifier: BranchNotifier): Router {
  const router = Router();

  /// Sube un lote de eventos del outbox. Idempotente por `eventId`: un
  /// reenvío vuelve como `duplicates` (es éxito para el dispositivo).
  router.post('/push', async (req, res) => {
    const device = requireDevice(req.device);
    const parsedBody = PushBody.safeParse(req.body);
    if (!parsedBody.success) {
      throw new HttpError(
        400,
        'invalid_batch',
        `Se esperan hasta ${MAX_PUSH_BATCH} eventos`,
      );
    }

    const accepted: { eventId: string; serverSeq: string }[] = [];
    const duplicates: string[] = [];
    const rejected: Rejected[] = [];
    const valid: PushedEvent[] = [];

    for (const raw of parsedBody.data.events) {
      const parsed = PushedEvent.safeParse(raw);
      if (!parsed.success) {
        const eventId =
          raw &&
          typeof raw === 'object' &&
          'eventId' in raw &&
          typeof raw.eventId === 'string'
            ? raw.eventId
            : null;
        rejected.push({
          eventId,
          code: 'invalid_event',
          message: parsed.error.issues[0]?.message ?? 'Evento inválido',
        });
        continue;
      }
      const reason = eventRejection(parsed.data);
      if (reason) rejected.push({ eventId: parsed.data.eventId, ...reason });
      else valid.push(parsed.data);
    }

    await db.$transaction(
      async (tx) => {
        // Un árbitro por sucursal a la vez: los pushes concurrentes de la
        // misma sucursal esperan aquí y se evalúan en orden.
        await tx.$queryRaw`SELECT id FROM branches WHERE id = ${device.branchId}::uuid FOR UPDATE`;

        for (const e of valid) {
          // Reenvío: idempotente si es de esta sucursal (no se re-arbitra); si
          // no, nunca se revela ni se mezcla entre tenants.
          const existing = await tx.event.findUnique({
            where: { eventId: e.eventId },
            select: { branchId: true },
          });
          if (existing) {
            if (existing.branchId === device.branchId) duplicates.push(e.eventId);
            else
              rejected.push({
                eventId: e.eventId,
                code: 'conflict_other_branch',
                message: 'El eventId ya existe en otra sucursal',
              });
            continue;
          }

          const verdict = await applyRules(tx, device, e);
          if (!verdict.ok) {
            rejected.push({
              eventId: e.eventId,
              code: verdict.code,
              message: verdict.message,
              ...(verdict.details ? { details: verdict.details } : {}),
            });
            continue;
          }
          const payload = verdict.payload;
          const [row] = await tx.$queryRaw<{ server_seq: bigint }[]>`
            INSERT INTO events (
              event_id, organization_id, branch_id, device_id, type,
              aggregate_type, aggregate_id, v, payload, user_id, device_created_at
            ) VALUES (
              ${e.eventId}::uuid, ${device.organizationId}::uuid, ${device.branchId}::uuid,
              ${device.id}::uuid, ${e.type}, ${e.aggregateType}, ${e.aggregateId},
              ${e.payload.v}, ${JSON.stringify(payload)}::jsonb, ${userIdOf(e.type, payload)},
              ${new Date(e.createdAtUtc)}
            )
            RETURNING server_seq`;
          await project(tx, device.branchId, e.type, e.aggregateId, payload, row!.server_seq);
          accepted.push({ eventId: e.eventId, serverSeq: row!.server_seq.toString() });
        }
      },
      { timeout: 30_000 },
    );

    // Aviso a los demás dispositivos de la sucursal (después del commit).
    const last = accepted.at(-1);
    if (last) notifier.notify(device.branchId, BigInt(last.serverSeq));

    res.json({ accepted, duplicates, rejected });
  });

  /// Eventos de la sucursal del token con serverSeq > after, en orden. Incluye
  /// los del propio dispositivo (el cliente los ignora por deviceId).
  router.get('/pull', async (req, res) => {
    const device = requireDevice(req.device);
    const { after, limit } = PullQuery.parse(req.query);
    const rows = await db.event.findMany({
      where: { branchId: device.branchId, serverSeq: { gt: after } },
      orderBy: { serverSeq: 'asc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({
      events: page.map((e) => ({
        serverSeq: e.serverSeq.toString(),
        eventId: e.eventId,
        deviceId: e.deviceId,
        type: e.type,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        payload: e.payload,
        createdAtUtc: e.deviceCreatedAt.toISOString(),
        receivedAt: e.receivedAt.toISOString(),
      })),
      hasMore: rows.length > limit,
      lastServerSeq: (last?.serverSeq ?? after).toString(),
    });
  });

  return router;
}
