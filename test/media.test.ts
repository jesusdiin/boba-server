import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { MAX_MEDIA_BYTES } from '../src/routes/media.js';
import { setupTestApp } from './helpers.js';

const t = setupTestApp();

// Unos bytes con cabecera JPEG (el servidor no decodifica la imagen).
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

const put = (token: string, id: string, body: Buffer, type = 'image/jpeg') =>
  request(t.app)
    .put(`/v1/media/${id}`)
    .set('authorization', `Bearer ${token}`)
    .set('content-type', type)
    .send(body);

const get = (token: string, id: string) =>
  request(t.app)
    .get(`/v1/media/${id}`)
    .set('authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

describe('fotos (/v1/media)', () => {
  it('se sube una vez, se baja igual y repetir la subida no falla', async () => {
    const { token } = await t.pairedDevice();
    const id = randomUUID();
    expect((await put(token, id, jpeg)).status).toBe(201);
    expect((await put(token, id, jpeg)).status).toBe(204);

    const res = await get(token, id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(Buffer.compare(res.body as Buffer, jpeg)).toBe(0);
  });

  it('otro equipo del mismo negocio la ve; otro negocio no', async () => {
    const a = await t.pairedDevice();
    const id = randomUUID();
    await put(a.token, id, jpeg);

    const sameOrg = await t.pairAnother(a.branchId);
    expect((await get(sameOrg.token, id)).status).toBe(200);

    const other = await t.pairedDevice();
    expect((await get(other.token, id)).status).toBe(404);
    // Ni puede pisarla.
    expect((await put(other.token, id, jpeg)).status).toBe(409);
  });

  it('rechaza tipos que no son foto, cuerpos vacíos y fotos enormes', async () => {
    const { token } = await t.pairedDevice();
    expect((await put(token, randomUUID(), jpeg, 'text/plain')).status).toBe(400);
    expect((await put(token, randomUUID(), Buffer.alloc(0))).status).toBe(400);
    expect(
      (await put(token, randomUUID(), Buffer.alloc(MAX_MEDIA_BYTES + 1))).status,
    ).toBe(413);
    expect((await put(token, 'no-es-uuid', jpeg)).status).toBe(400);
  });

  it('sin token: 401', async () => {
    const id = randomUUID();
    expect((await request(t.app).get(`/v1/media/${id}`)).status).toBe(401);
    expect(
      (await request(t.app).put(`/v1/media/${id}`).set('content-type', 'image/jpeg').send(jpeg))
        .status,
    ).toBe(401);
  });

  it('una foto que no existe: 404', async () => {
    const { token } = await t.pairedDevice();
    expect((await get(token, randomUUID())).status).toBe(404);
  });
});
