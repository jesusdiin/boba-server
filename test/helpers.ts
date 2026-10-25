import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach } from 'vitest';

import { createApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { InProcessBranchNotifier } from '../src/realtime/branchNotifier.js';
import { attachRealtime } from '../src/realtime/wsServer.js';
import { PairingThrottle } from '../src/routes/devices.js';

export const ADMIN_KEY = process.env.ADMIN_API_KEY ?? '';

/// App + DB de pruebas; las tablas se vacían antes de cada test.
export function setupTestApp() {
  const db = createDb(process.env.DATABASE_URL ?? '');
  const logger = pino({ level: 'silent' });
  const notifier = new InProcessBranchNotifier();
  const app = createApp({
    db,
    adminApiKey: ADMIN_KEY,
    logger,
    pairingThrottle: new PairingThrottle(1000),
    notifier,
  });

  // Servidor HTTP real (puerto efímero) solo para los tests de WebSocket.
  let server: Server | undefined;
  let realtime: { close: () => void } | undefined;
  async function listen(heartbeatMs = 30_000): Promise<string> {
    if (!server) {
      const s = app.listen(0);
      await new Promise<void>((resolve) => s.once('listening', () => resolve()));
      server = s;
      realtime = attachRealtime(s, { db, notifier, logger, heartbeatMs });
    }
    const { port } = server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/v1/ws`;
  }

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE events, device_pairing_codes, devices, branches, organizations RESTART IDENTITY CASCADE',
    );
  });
  afterAll(async () => {
    realtime?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await db.$disconnect();
  });

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

  return { app, db, notifier, listen, admin, pairedDevice, pairAnother, push, pull };
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
        userId: null,
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

// --- Fábricas para las reglas del árbitro (Fase 4) -------------------------

const at = '2026-08-20T15:00:00.000Z';

/// Sobre de evento con la forma del outbox.
export function envelope(
  type: string,
  aggregateType: string,
  aggregateId: string,
  row: Record<string, unknown>,
) {
  return {
    eventId: randomUUID(),
    type,
    aggregateType,
    aggregateId,
    createdAtUtc: at,
    payload: { v: 1, ...row },
  };
}

export function userCreated(role: string, id = randomUUID(), isActive = true) {
  return envelope('user.created', 'user', id, {
    id,
    displayName: role,
    role,
    pinHash: 'h',
    pinSalt: 's',
    isActive,
    createdAtUtc: at,
    updatedAtUtc: at,
    version: 1,
  });
}

export function shiftRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    deviceId: 'd',
    branchId: 'b',
    openedAtUtc: at,
    openedBusinessDate: '2026-08-20',
    startingCashCents: 100000,
    status: 'open',
    openedByUserId: null,
    closedByUserId: null,
    version: 1,
    ...extra,
  };
}

export const shiftOpened = (id: string, extra: Record<string, unknown> = {}) =>
  envelope('shift.opened', 'shift', id, shiftRow(id, extra));

export const shiftClosed = (id: string, extra: Record<string, unknown> = {}) =>
  envelope(
    'shift.closed',
    'shift',
    id,
    shiftRow(id, { status: 'closed', closingCountedCashCents: 0, version: 2, ...extra }),
  );

export function orderRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    channel: 'instagram',
    customerName: 'Sofía',
    status: 'pending',
    itemsJson: '[]',
    saleId: null,
    createdByUserId: null,
    deviceId: 'd',
    shiftId: null,
    createdAtUtc: at,
    updatedAtUtc: at,
    version: 1,
    ...extra,
  };
}

export const orderCreated = (id: string, extra: Record<string, unknown> = {}) =>
  envelope('incoming_order.created', 'incoming_order', id, orderRow(id, extra));

export const orderCancelled = (id: string, extra: Record<string, unknown> = {}) =>
  envelope(
    'incoming_order.cancelled',
    'incoming_order',
    id,
    orderRow(id, { status: 'cancelled', version: 2, ...extra }),
  );

/// Venta en `shiftId`; con `orderId`, cumple ese pedido.
export function sale(
  shiftId: string,
  opts: { userId?: string | null; orderId?: string; orderVersion?: number } = {},
) {
  const id = randomUUID();
  return envelope('sale.created', 'sale', id, {
    sale: { id, shiftId, totalCents: 5000, userId: opts.userId ?? null },
    items: [],
    modifiers: [],
    payments: [],
    incomingOrder: opts.orderId
      ? orderRow(opts.orderId, {
          status: 'fulfilled',
          saleId: id,
          shiftId,
          version: opts.orderVersion ?? 2,
        })
      : null,
  });
}

export const productUpserted = (id: string, version: number, name: string) =>
  envelope('product.upserted', 'product', id, { id, name, basePriceCents: 5000, version });
