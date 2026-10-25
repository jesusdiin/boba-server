import { describe, expect, it } from 'vitest';

import { saleCreatedEvent, setupTestApp, userUpdatedEvent } from './helpers.js';

const t = setupTestApp();

describe('POST /v1/sync/push', () => {
  it('acepta eventos y asigna serverSeq creciente', async () => {
    const { token, deviceId } = await t.pairedDevice();
    const events = [saleCreatedEvent(), userUpdatedEvent()];

    const res = await t.push(token, events);
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([]);
    const seqs = res.body.accepted.map((a: { serverSeq: string }) => BigInt(a.serverSeq));
    expect(seqs).toHaveLength(2);
    expect(seqs[1]! > seqs[0]!).toBe(true);

    const stored = await t.db.event.findMany({ orderBy: { serverSeq: 'asc' } });
    expect(stored.map((e) => e.type)).toEqual(['sale.created', 'user.updated']);
    expect(stored[0]).toMatchObject({ deviceId, v: 1, userId: null });
    expect(stored[0]!.payload).toMatchObject({ sale: { channel: 'instagram' } });
  });

  it('el mismo lote repetido no duplica: vuelve como duplicates', async () => {
    const { token } = await t.pairedDevice();
    const events = [saleCreatedEvent(), userUpdatedEvent()];

    await t.push(token, events);
    const again = await t.push(token, events);

    expect(again.status).toBe(200);
    expect(again.body.accepted).toEqual([]);
    expect(again.body.duplicates).toEqual(events.map((e) => e.eventId));
    expect(await t.db.event.count()).toBe(2);
  });

  it('rechaza tipo desconocido o v no soportada sin afectar al resto', async () => {
    const { token } = await t.pairedDevice();
    const good = userUpdatedEvent();
    const unknown = userUpdatedEvent({ type: 'loyalty.created' });
    const tooNew = userUpdatedEvent({ v: 99 });
    const malformed = { eventId: 'no-es-uuid', type: 'user.updated' };

    const res = await t.push(token, [good, unknown, tooNew, malformed]);

    expect(res.body.accepted.map((a: { eventId: string }) => a.eventId)).toEqual([
      good.eventId,
    ]);
    // En el mismo orden del lote.
    expect(res.body.rejected.map((r: { code: string }) => r.code)).toEqual([
      'unknown_type',
      'unsupported_version',
      'invalid_event',
    ]);
    expect(await t.db.event.count()).toBe(1);
  });

  it('un lote de más de 500 eventos es 400', async () => {
    const { token } = await t.pairedDevice();
    const res = await t.push(
      token,
      Array.from({ length: 501 }, () => userUpdatedEvent()),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_batch');
  });

  it('sin token o con token inválido es 401', async () => {
    expect((await t.push('token-falso', [])).status).toBe(401);
  });
});
