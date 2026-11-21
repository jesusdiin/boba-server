import express, { Router } from 'express';
import { z } from 'zod';

import { requireDevice } from '../auth/deviceAuth.js';
import type { Db } from '../db.js';
import { HttpError, notFound } from '../errors.js';

/// Tamaño máximo de una foto (la app las manda a ~800 px, ~80 KB).
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024;

const CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const mediaId = z.uuid();

const invalid = (message: string) => new HttpError(400, 'invalid_media', message);

/// Fotos de productos y sabores. La organización sale del token: un equipo
/// solo sube y baja fotos de su propio negocio.
export function mediaRouter(db: Db): Router {
  const router = Router();

  router.put(
    '/:id',
    express.raw({ type: () => true, limit: MAX_MEDIA_BYTES }),
    async (req, res) => {
      const device = requireDevice(req.device);
      const id = mediaId.parse(req.params.id);
      const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (!CONTENT_TYPES.has(contentType)) {
        throw invalid('Solo fotos JPEG, PNG o WebP');
      }
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bytes.length === 0) throw invalid('La foto está vacía');

      const existing = await db.media.findUnique({
        where: { id },
        select: { organizationId: true },
      });
      if (existing) {
        // Reintento de la misma foto: listo. De otro negocio: no se revela.
        if (existing.organizationId !== device.organizationId) {
          throw new HttpError(409, 'media_conflict', 'Ese id ya está en uso');
        }
        res.status(204).end();
        return;
      }
      await db.media.create({
        data: {
          id,
          organizationId: device.organizationId,
          contentType,
          bytes: new Uint8Array(bytes),
          sizeBytes: bytes.length,
        },
      });
      res.status(201).end();
    },
  );

  router.get('/:id', async (req, res) => {
    const device = requireDevice(req.device);
    const parsed = mediaId.safeParse(req.params.id);
    if (!parsed.success) throw notFound('Foto no encontrada');
    const media = await db.media.findUnique({ where: { id: parsed.data } });
    if (!media || media.organizationId !== device.organizationId) {
      throw notFound('Foto no encontrada');
    }
    res
      .status(200)
      .set('content-type', media.contentType)
      // El id nunca cambia de contenido.
      .set('cache-control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(media.bytes));
  });

  return router;
}
