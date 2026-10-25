import { Router } from 'express';
import { z } from 'zod';

import { requireDevice } from '../auth/deviceAuth.js';
import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
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

type Rejected = { eventId: string | null; code: string; message: string };

/// `userId` del payload cuando el evento lo trae (auditoría y Fase 4).
const userIdOf = (payload: Record<string, unknown>): string | null =>
  typeof payload.userId === 'string' ? payload.userId : null;

export function syncRouter(db: Db): Router {
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

    await db.$transaction(async (tx) => {
      for (const e of valid) {
        const inserted = await tx.$queryRaw<{ server_seq: bigint }[]>`
          INSERT INTO events (
            event_id, organization_id, branch_id, device_id, type,
            aggregate_type, aggregate_id, v, payload, user_id, device_created_at
          ) VALUES (
            ${e.eventId}::uuid, ${device.organizationId}::uuid, ${device.branchId}::uuid,
            ${device.id}::uuid, ${e.type}, ${e.aggregateType}, ${e.aggregateId},
            ${e.payload.v}, ${JSON.stringify(e.payload)}::jsonb, ${userIdOf(e.payload)},
            ${new Date(e.createdAtUtc)}
          )
          ON CONFLICT (event_id) DO NOTHING
          RETURNING server_seq`;
        const row = inserted[0];
        if (row) {
          accepted.push({ eventId: e.eventId, serverSeq: row.server_seq.toString() });
          continue;
        }
        // Ya existía: idempotente si es de esta sucursal; si no, nunca se
        // revela ni se mezcla entre tenants.
        const existing = await tx.event.findUnique({
          where: { eventId: e.eventId },
          select: { branchId: true },
        });
        if (existing?.branchId === device.branchId) duplicates.push(e.eventId);
        else
          rejected.push({
            eventId: e.eventId,
            code: 'conflict_other_branch',
            message: 'El eventId ya existe en otra sucursal',
          });
      }
    });

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
