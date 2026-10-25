import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import { newDeviceToken, normalizePairingCode, sha256 } from '../tokens.js';

const PairBody = z.object({
  code: z.string().min(1),
  deviceName: z.string().trim().min(1).max(80),
  mode: z.enum(['staff', 'kiosk']).default('staff'),
});

/// Freno simple contra adivinar códigos: N intentos fallidos por IP por
/// ventana. En memoria (una instancia); suficiente para la Fase 1.
export class PairingThrottle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  ensureAllowed(ip: string, now = Date.now()): void {
    const entry = this.failures.get(ip);
    if (entry && entry.resetAt > now && entry.count >= this.maxFailures) {
      throw new HttpError(
        429,
        'too_many_attempts',
        'Demasiados intentos; espera unos minutos',
      );
    }
  }

  recordFailure(ip: string, now = Date.now()): void {
    const entry = this.failures.get(ip);
    if (!entry || entry.resetAt <= now) {
      this.failures.set(ip, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }
}

export function devicesRouter(db: Db, throttle = new PairingThrottle()): Router {
  const router = Router();

  /// Canjea un código de sucursal por un token de dispositivo. El token en
  /// claro solo viaja en esta respuesta.
  router.post('/pair', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    throttle.ensureAllowed(ip);
    const body = PairBody.parse(req.body);
    const codeHash = sha256(normalizePairingCode(body.code));
    const token = newDeviceToken();

    const result = await db.$transaction(async (tx) => {
      const code = await tx.devicePairingCode.findUnique({
        where: { codeHash },
        include: { branch: true },
      });
      if (!code || code.usedAt || code.expiresAt <= new Date()) return null;
      const device = await tx.device.create({
        data: {
          organizationId: code.branch.organizationId,
          branchId: code.branchId,
          name: body.deviceName,
          mode: body.mode,
          tokenHash: sha256(token),
        },
      });
      // `usedAt: null` en el where: si dos dispositivos canjean a la vez,
      // solo uno actualiza y el otro aborta la transacción.
      const claimed = await tx.devicePairingCode.updateMany({
        where: { id: code.id, usedAt: null },
        data: { usedAt: new Date(), usedByDeviceId: device.id },
      });
      if (claimed.count !== 1)
        throw new HttpError(409, 'code_already_used', 'Código ya usado');
      return { device, branch: code.branch };
    });

    if (!result) {
      throttle.recordFailure(ip);
      throw new HttpError(400, 'invalid_code', 'Código inválido, usado o vencido');
    }

    res.status(201).json({
      deviceId: result.device.id,
      token,
      organizationId: result.device.organizationId,
      branch: {
        id: result.branch.id,
        name: result.branch.name,
        timezoneId: result.branch.timezoneId,
        currencyCode: result.branch.currencyCode,
      },
    });
  });

  return router;
}
