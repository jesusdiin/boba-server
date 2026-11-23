import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { purgeUnusedMedia } from '../src/media/cleanup.js';
import { MAX_MEDIA_BYTES } from '../src/routes/media.js';
import { envelope, setupTestApp } from './helpers.js';

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
      (
        await request(t.app)
          .put(`/v1/media/${id}`)
          .set('content-type', 'image/jpeg')
          .send(jpeg)
      ).status,
    ).toBe(401);
  });

  it('una foto que no existe: 404', async () => {
    const { token } = await t.pairedDevice();
    expect((await get(token, randomUUID())).status).toBe(404);
  });
});

describe('limpieza de fotos sin usar', () => {
  /// Producto (o sabor) que usa la foto [mediaId].
  const product = (id: string, mediaId: string | null, version = 1) =>
    envelope('product.upserted', 'product', id, {
      id,
      name: 'Taro',
      basePriceCents: 5000,
      imagePath: mediaId ? `media:${mediaId}` : null,
      version,
    });
  const option = (id: string, mediaId: string) =>
    envelope('modifier_option.upserted', 'modifier_option', id, {
      id,
      name: 'Fresa',
      priceDeltaCents: 0,
      imagePath: `media:${mediaId}`,
      version: 1,
    });

  /// Envejece todas las fotos [days] días (con el reloj de la base).
  const age = (days: number) =>
    t.db
      .$executeRaw`UPDATE media SET created_at = now() - make_interval(days => ${days})`;

  it('borra las viejas sin usar; respeta las usadas y las recientes', async () => {
    const d = await t.pairedDevice();
    const [used, flavor, replaced, orphan] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    for (const id of [used, flavor, replaced, orphan]) await put(d.token, id, jpeg);
    const p1 = randomUUID();
    const p2 = randomUUID();
    await t.push(d.token, [
      product(p1, used),
      option(randomUUID(), flavor),
      product(p2, replaced),
    ]);
    // El producto 2 cambió de foto: la anterior queda sin usar.
    await t.push(d.token, [product(p2, used, 2)]);

    await age(3);
    expect(await purgeUnusedMedia(t.db)).toBe(0);

    await age(8);
    expect(await purgeUnusedMedia(t.db)).toBe(2);
    const left = (await t.db.media.findMany({ select: { id: true } })).map((m) => m.id);
    expect(left.sort()).toEqual([used, flavor].sort());
  });

  it('una foto que otro negocio usa con el mismo texto no salva la propia', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairedDevice();
    const id = randomUUID();
    await put(a.token, id, jpeg);
    // Otro negocio "apunta" a ese id: no cuenta.
    await t.push(b.token, [product(randomUUID(), id)]);
    await age(8);
    expect(await purgeUnusedMedia(t.db)).toBe(1);
  });
});
