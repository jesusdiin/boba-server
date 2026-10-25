import { z } from 'zod';

/// Tipos y versión vigente del payload; espejo de `EventTypes` en la app
/// (boba_pos/lib/core/sync/event_types.dart, docs/EVENTOS.md).
export const EVENT_SCHEMA_VERSIONS: Readonly<Record<string, number>> = {
  'sale.created': 1,
  'cash_movement.created': 1,
  'supply_movement.created': 1,
  'supply.upserted': 1,
  'incoming_order.created': 1,
  'incoming_order.cancelled': 1,
  'user.created': 1,
  'user.updated': 1,
  'shift.opened': 1,
  'shift.closed': 1,
  'category.upserted': 1,
  'product.upserted': 1,
  'modifier_group.upserted': 1,
  'modifier_option.upserted': 1,
  'product_modifier_group.upserted': 1,
};

export const MAX_PUSH_BATCH = 500;

/// Sobre de un evento tal como lo sube el dispositivo (fila de su outbox).
export const PushedEvent = z.object({
  eventId: z.uuid(),
  type: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  payload: z.looseObject({ v: z.number().int().min(1) }),
  createdAtUtc: z.iso.datetime({ offset: true }),
});
export type PushedEvent = z.infer<typeof PushedEvent>;

/// El cuerpo se valida como lista de objetos; cada evento se valida aparte
/// para rechazar solo los inválidos y aceptar el resto del lote.
export const PushBody = z.object({
  events: z.array(z.unknown()).max(MAX_PUSH_BATCH),
});

/// `null` si es válido; si no, el motivo del rechazo.
export function eventRejection(
  event: PushedEvent,
): { code: string; message: string } | null {
  const supported = EVENT_SCHEMA_VERSIONS[event.type];
  if (supported === undefined) {
    return { code: 'unknown_type', message: `Tipo de evento desconocido: ${event.type}` };
  }
  if (event.payload.v > supported) {
    return {
      code: 'unsupported_version',
      message: `${event.type} v${event.payload.v} no soportada (máx. v${supported})`,
    };
  }
  return null;
}
