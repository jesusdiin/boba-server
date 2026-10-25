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

/// Token del header `Authorization: Bearer <token>`, o `null`.
export function bearerToken(header: string | undefined): string | null {
  return /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? null;
}

/// Dispositivo vigente dueño del token (HTTP y WebSocket), o `null` si no
/// existe o fue revocado. Marca `lastSeenAt`.
export async function resolveDevice(
  db: Db,
  token: string,
): Promise<DeviceContext | null> {
  const device = await db.device.findUnique({ where: { tokenHash: sha256(token) } });
  if (!device || device.revokedAt) return null;
  await db.device.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date() },
  });
  return {
    id: device.id,
    organizationId: device.organizationId,
    branchId: device.branchId,
  };
}

export const deviceAuth =
  (db: Db): RequestHandler =>
  async (req, _res, next) => {
    const token = bearerToken(req.header('authorization'));
    if (!token) throw unauthorized('Falta el token del dispositivo');
    const device = await resolveDevice(db, token);
    if (!device) throw unauthorized('Token inválido o revocado');
    req.device = device;
    next();
  };

/// Para handlers detrás de `deviceAuth`.
export function requireDevice(device: DeviceContext | undefined): DeviceContext {
  if (!device) throw unauthorized();
  return device;
}
