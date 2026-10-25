import { randomUUID } from 'node:crypto';

import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach } from 'vitest';

import { createApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { PairingThrottle } from '../src/routes/devices.js';

export const ADMIN_KEY = process.env.ADMIN_API_KEY ?? '';

/// App + DB de pruebas; las tablas se vacían antes de cada test.
export function setupTestApp() {
  const db = createDb(process.env.DATABASE_URL ?? '');
  const app = createApp({
    db,
    adminApiKey: ADMIN_KEY,
    logger: pino({ level: 'silent' }),
    pairingThrottle: new PairingThrottle(1000),
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE events, device_pairing_codes, devices, branches, organizations RESTART IDENTITY CASCADE',
    );
  });
  afterAll(() => db.$disconnect());

  const admin = () => ({
    post: (path: string, body?: object) =>
      request(app).post(`/v1/admin${path}`).set('x-admin-key', ADMIN_KEY).send(body),
    get: (path: string) =>
      request(app).get(`/v1/admin${path}`).set('x-admin-key', ADMIN_KEY),
  });

  /// Organización + sucursal + dispositivo emparejado; devuelve su token.
  async function pairedDevice(opts: { orgId?: string; deviceName?: string } = {}) {
    const orgId =
      opts.orgId ??
      (await admin().post('/organizations', { name: 'Boba & Co.' })).body.id;
    const branch = (
      await admin().post(`/organizations/${orgId}/branches`, { name: 'Centro' })
    ).body;
    const { code } = (await admin().post(`/branches/${branch.id}/pairing-codes`)).body;
    const paired = await request(app)
      .post('/v1/devices/pair')
      .send({ code, deviceName: opts.deviceName ?? 'iPad caja' });
    return {
      orgId: orgId as string,
      branchId: branch.id as string,
      deviceId: paired.body.deviceId as string,
      token: paired.body.token as string,
    };
  }

  /// Otro dispositivo en una sucursal existente.
  async function pairAnother(branchId: string, deviceName = 'iPad kiosco') {
    const { code } = (await admin().post(`/branches/${branchId}/pairing-codes`)).body;
    const paired = await request(app).post('/v1/devices/pair').send({ code, deviceName });
    return {
      deviceId: paired.body.deviceId as string,
      token: paired.body.token as string,
    };
  }

  const push = (token: string, events: unknown[]) =>
    request(app)
      .post('/v1/sync/push')
      .set('authorization', `Bearer ${token}`)
      .send({ events });

  const pull = (token: string, query: Record<string, string | number> = {}) =>
    request(app)
      .get('/v1/sync/pull')
      .set('authorization', `Bearer ${token}`)
      .query(query);

  return { app, db, admin, pairedDevice, pairAnother, push, pull };
}

/// Evento con la forma del outbox de la app (docs/EVENTOS.md).
export function userUpdatedEvent(
  overrides: Partial<{ eventId: string; v: number; type: string }> = {},
) {
  const userId = randomUUID();
  return {
    eventId: overrides.eventId ?? randomUUID(),
    type: overrides.type ?? 'user.updated',
    aggregateType: 'user',
    aggregateId: userId,
    createdAtUtc: '2026-08-20T15:10:00.000Z',
    payload: {
      v: overrides.v ?? 1,
      id: userId,
      displayName: 'Ana G.',
      role: 'waiter',
      pinHash: '+lEXSvEITlOgOg+4hDhHUvaiQtnauPo/81jW0blzLzM=',
      pinSalt: 'Oh91XOMtDojTatazWVmulg==',
      isActive: true,
      createdAtUtc: '2026-08-20T12:00:00.000Z',
      updatedAtUtc: '2026-08-20T15:10:00.000Z',
      version: 2,
    },
  };
}

export function saleCreatedEvent() {
  const saleId = randomUUID();
  return {
    eventId: randomUUID(),
    type: 'sale.created',
    aggregateType: 'sale',
    aggregateId: saleId,
    createdAtUtc: '2026-08-20T18:00:00.000Z',
    payload: {
      v: 1,
      sale: {
        id: saleId,
        shiftId: randomUUID(),
        totalCents: 13000,
        channel: 'instagram',
        userId: 'user-ana',
        createdAtUtc: '2026-08-20T18:00:00.000Z',
      },
      items: [
        {
          id: randomUUID(),
          saleId,
          productNameSnapshot: 'Brown Sugar Boba',
          quantity: 2,
        },
      ],
      modifiers: [],
      payments: [{ id: randomUUID(), saleId, method: 'card', amountCents: 13000 }],
      incomingOrder: null,
    },
  };
}
