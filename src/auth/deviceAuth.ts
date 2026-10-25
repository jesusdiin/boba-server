import type { RequestHandler } from 'express';

import type { Db } from '../db.js';
import { unauthorized } from '../errors.js';
import { sha256 } from '../tokens.js';

/// Identidad del dispositivo resuelta desde su token. Organización y sucursal
/// salen **solo** de aquí, nunca del body.
export interface DeviceContext {
  id: string;
  organizationId: string;
  branchId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      device?: DeviceContext;
    }
  }
}

export const deviceAuth =
  (db: Db): RequestHandler =>
  async (req, _res, next) => {
    const match = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!match?.[1]) throw unauthorized('Falta el token del dispositivo');
    const device = await db.device.findUnique({ where: { tokenHash: sha256(match[1]) } });
    if (!device || device.revokedAt) throw unauthorized('Token inválido o revocado');
    await db.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    req.device = {
      id: device.id,
      organizationId: device.organizationId,
      branchId: device.branchId,
    };
    next();
  };

/// Para handlers detrás de `deviceAuth`.
export function requireDevice(device: DeviceContext | undefined): DeviceContext {
  if (!device) throw unauthorized();
  return device;
}
