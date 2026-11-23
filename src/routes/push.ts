import { Router } from 'express';
import { z } from 'zod';

import { bearerToken, resolveDevice } from '../auth/deviceAuth.js';
import type { Db } from '../db.js';
import { MemoryThrottle, type Throttle } from '../throttle.js';

const TokenBody = z.object({ token: z.string().trim().min(10).max(4096) });

const Register = TokenBody.extend({
  platform: z.enum(['android', 'ios']),
  appVersion: z.string().trim().max(40).optional(),
  locale: z.string().trim().max(20).optional(),
});

/// Registro de instalaciones para notificaciones push. Público: la app sin
/// nube también se registra (anónima). Con token de equipo válido, la
/// instalación queda ligada a su negocio.
export function pushRouter(
  db: Db,
  throttle: Throttle = new MemoryThrottle(30, 15 * 60 * 1000),
): Router {
  const router = Router();

  router.put('/token', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    await throttle.ensureAllowed(ip);
    await throttle.recordFailure(ip);
    const body = Register.parse(req.body);
    const bearer = bearerToken(req.header('authorization'));
    const device = bearer ? await resolveDevice(db, bearer) : null;
    const data = {
      platform: body.platform,
      appVersion: body.appVersion ?? null,
      locale: body.locale ?? null,
      organizationId: device?.organizationId ?? null,
      deviceId: device?.id ?? null,
      lastSeenAt: new Date(),
    };
    await db.pushToken.upsert({
      where: { token: body.token },
      create: { token: body.token, ...data },
      update: data,
    });
    res.json({ linked: device != null });
  });

  router.delete('/token', async (req, res) => {
    const { token } = TokenBody.parse(req.body);
    await db.pushToken.deleteMany({ where: { token } });
    res.status(204).end();
  });

  return router;
}
