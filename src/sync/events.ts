import { createHash } from 'node:crypto';

import { actorAndPermission } from './permissions.js';
import { project, type Tx } from './rules.js';

type Payload = Record<string, unknown>;

/// Evento ya arbitrado, listo para guardarse en una sucursal.
export interface StoredEvent {
  eventId: string;
  organizationId: string;
  branchId: string;
  deviceId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Payload & { v: number };
  createdAt: Date;
}

/// Guarda el evento en `events` y actualiza las proyecciones, en la misma
/// transacción. Devuelve su `serverSeq`.
export async function insertEvent(tx: Tx, e: StoredEvent): Promise<bigint> {
  const userId = actorAndPermission(e.type, e.payload)?.actor ?? null;
  const [row] = await tx.$queryRaw<{ server_seq: bigint }[]>`
    INSERT INTO events (
      event_id, organization_id, branch_id, device_id, type,
      aggregate_type, aggregate_id, v, payload, user_id, device_created_at
    ) VALUES (
      ${e.eventId}::uuid, ${e.organizationId}::uuid, ${e.branchId}::uuid,
      ${e.deviceId}::uuid, ${e.type}, ${e.aggregateType}, ${e.aggregateId},
      ${e.payload.v}, ${JSON.stringify(e.payload)}::jsonb, ${userId},
      ${e.createdAt}
    )
    RETURNING server_seq`;
  await project(tx, e.branchId, e.type, e.aggregateId, e.payload, row!.server_seq);
  return row!.server_seq;
}

/// UUID determinista (v5, SHA-1) a partir de [parts]: copiar el mismo evento
/// a la misma sucursal da siempre el mismo `eventId` (reintentos
/// idempotentes).
export function derivedEventId(...parts: string[]): string {
  const hash = createHash('sha1').update(`boba:${parts.join(':')}`).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // versión 5
  b[8] = (b[8]! & 0x3f) | 0x80; // variante RFC 4122
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
