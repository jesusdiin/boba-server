import { describe, expect, it } from 'vitest';

import { setupTestApp, userUpdatedEvent } from './helpers.js';

const t = setupTestApp();

describe('GET /v1/sync/pull', () => {
  it('pagina en orden con after + limit, sin huecos ni repetidos', async () => {
    const { token, branchId } = await t.pairedDevice();
    const other = await t.pairAnother(branchId);
    const pushed = Array.from({ length: 7 }, () => userUpdatedEvent());
    await t.push(token, pushed.slice(0, 4));
    await t.push(other.token, pushed.slice(4));

    const seen: string[] = [];
    let after = '0';
    let pages = 0;
    for (;;) {
      const res = await t.pull(other.token, { after, limit: 3 });
      expect(res.status).toBe(200);
      seen.push(...res.body.events.map((e: { eventId: string }) => e.eventId));
      after = res.body.lastServerSeq;
      pages++;
      if (!res.body.hasMore) break;
    }

    expect(pages).toBe(3);
    expect(seen).toEqual(pushed.map((e) => e.eventId));
    const empty = await t.pull(other.token, { after });
    expect(empty.body).toMatchObject({
      events: [],
      hasMore: false,
      lastServerSeq: after,
    });
  });

  it('un dispositivo nuevo baja toda la sucursal desde cero (≥ 1,000 eventos)', async () => {
    const { token, branchId } = await t.pairedDevice();
    const pushed = Array.from({ length: 1203 }, () => userUpdatedEvent());
    for (let i = 0; i < pushed.length; i += 500) {
      const res = await t.push(token, pushed.slice(i, i + 500));
      expect(res.status).toBe(200);
    }

    const fresh = await t.pairAnother(branchId, 'iPad nuevo');
    const seen: string[] = [];
    let after = '0';
    let pages = 0;
    for (;;) {
      const res = await t.pull(fresh.token, { after, limit: 500 });
      seen.push(...res.body.events.map((e: { eventId: string }) => e.eventId));
      after = res.body.lastServerSeq;
      pages++;
      if (!res.body.hasMore) break;
    }

    expect(pages).toBe(3);
    expect(seen).toEqual(pushed.map((e) => e.eventId));
  });

  it('devuelve el sobre completo y quién lo subió', async () => {
    const { token, deviceId } = await t.pairedDevice();
    const event = userUpdatedEvent();
    await t.push(token, [event]);

    const [pulled] = (await t.pull(token)).body.events;
    expect(pulled).toMatchObject({
      eventId: event.eventId,
      deviceId,
      type: 'user.updated',
      aggregateId: event.aggregateId,
      payload: event.payload,
      createdAtUtc: event.createdAtUtc,
    });
    expect(typeof pulled.serverSeq).toBe('string');
  });

  it('valida los parámetros', async () => {
    const { token } = await t.pairedDevice();
    expect((await t.pull(token, { after: '-1' })).status).toBe(400);
    expect((await t.pull(token, { limit: 1000 })).status).toBe(400);
  });
});
