import { Writable } from 'node:stream';

import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createDb } from '../src/db.js';

describe('logs', () => {
  it('no registran el token, la cookie ni la llave admin', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const db = createDb(process.env.DATABASE_URL ?? '');
    const app = createApp({
      db,
      adminApiKey: 'llave-admin-secreta',
      logger: pino({ level: 'info' }, sink),
    });
    await request(app)
      .get('/v1/sync/pull')
      .set('authorization', 'Bearer token-secreto-del-equipo')
      .set('cookie', 'boba_ops=sesion-secreta');
    await request(app).get('/v1/admin/organizations/x').set('x-admin-key', 'llave-admin-secreta');
    await db.$disconnect();

    const log = lines.join('\n');
    expect(log).toContain('/v1/sync/pull');
    expect(log).toContain('[Redacted]');
    expect(log).not.toContain('token-secreto-del-equipo');
    expect(log).not.toContain('sesion-secreta');
    expect(log).not.toContain('llave-admin-secreta');
  });
});
