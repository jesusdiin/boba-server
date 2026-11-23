import { pino } from 'pino';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { MemoryThrottle } from '../src/throttle.js';

const db = createDb(process.env.DATABASE_URL ?? '');
afterAll(() => db.$disconnect());

/// Freno del emparejamiento con límite 1: un código inválido cuenta como
/// intento y el segundo de la misma IP se rechaza (429).
function app(trustProxy: string | boolean) {
  return createApp({
    db,
    adminApiKey: 'llave-admin-secreta',
    logger: pino({ level: 'silent' }),
    pairingThrottle: new MemoryThrottle(1, 60_000),
    trustProxy,
  });
}

const pair = (a: ReturnType<typeof app>, ip: string) =>
  request(a)
    .post('/v1/devices/pair')
    .set('x-forwarded-for', ip)
    .send({ code: 'NOEXISTE', deviceName: 'iPad' });

describe('IP real detrás de nginx', () => {
  it('con trust proxy, cada cliente tiene su propio freno', async () => {
    const a = app('loopback');
    expect((await pair(a, '203.0.113.1')).status).toBe(400);
    expect((await pair(a, '203.0.113.2')).status).toBe(400);
    expect((await pair(a, '203.0.113.1')).status).toBe(429);
  });

  it('sin trust proxy, todos comparten la IP del proxy', async () => {
    const a = app(false);
    expect((await pair(a, '203.0.113.1')).status).toBe(400);
    expect((await pair(a, '203.0.113.2')).status).toBe(429);
  });
});
