import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import { createDevice, pairResponse } from '../pairing.js';
import { PairingThrottle } from './devices.js';

const SignupBody = z.object({
  organizationName: z.string().trim().min(1).max(80),
  branchName: z.string().trim().min(1).max(80),
  deviceName: z.string().trim().min(1).max(80),
  timezoneId: z.string().min(1).optional(),
  currencyCode: z.string().length(3).optional(),
});

/// Registro desde la app: el primer dispositivo crea la organización y su
/// sucursal y queda emparejado (misma respuesta que `/v1/devices/pair`).
export function signupRouter(
  db: Db,
  {
    enabled = true,
    throttle = new PairingThrottle(5, 60 * 60 * 1000),
  }: { enabled?: boolean; throttle?: PairingThrottle } = {},
): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    if (!enabled) {
      throw new HttpError(403, 'signup_disabled', 'El registro de negocios está cerrado');
    }
    const ip = req.ip ?? 'unknown';
    throttle.ensureAllowed(ip);
    const body = SignupBody.parse(req.body);
    // Cada registro cuenta (no solo los fallidos): frena altas en masa.
    throttle.recordFailure(ip);

    const result = await db.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name: body.organizationName } });
      const branch = await tx.branch.create({
        data: {
          organizationId: org.id,
          name: body.branchName,
          timezoneId: body.timezoneId,
          currencyCode: body.currencyCode,
        },
      });
      const { device, token } = await createDevice(tx, {
        organizationId: org.id,
        branchId: branch.id,
        name: body.deviceName,
        mode: 'staff',
      });
      return pairResponse(device, branch, token);
    });

    res.status(201).json(result);
  });

  return router;
}
