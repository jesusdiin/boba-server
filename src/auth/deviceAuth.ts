import type { RequestHandler } from 'express';

import type { Db } from '../db.js';
import { HttpError, unauthorized } from '../errors.js';
import { entitlementsOf, planJson, type Entitlements } from '../plans.js';
import { sha256 } from '../tokens.js';

/// Identidad del dispositivo resuelta desde su token. Organización y sucursal
/// salen **solo** de aquí, nunca del body.
export interface DeviceContext {
  id: string;
  organizationId: string;
  branchId: string;
  /// Modo vigente; cambia dentro de un push con `device.mode_changed`.
  mode: 'staff' | 'kiosk';
  /// Letra de folio del equipo (se devuelve en el pull).
  folioPrefix: string;
  /// Plan de la organización al resolver el token.
  entitlements: Entitlements;
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
  const device = await db.device.findUnique({
    where: { tokenHash: sha256(token) },
    include: { organization: true },
  });
  if (!device || device.revokedAt) return null;
  await db.device.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date() },
  });
  return {
    id: device.id,
    organizationId: device.organizationId,
    branchId: device.branchId,
    mode: device.mode,
    folioPrefix: device.folioPrefix,
    entitlements: entitlementsOf(device.organization, new Date()),
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

/// Error de plan vencido: la nube se pausa (la app sigue cobrando offline).
export function subscriptionInactive(
  entitlements: Entitlements,
  organizationId?: string,
): HttpError {
  return new HttpError(
    402,
    'subscription_inactive',
    'Tu plan venció: la sincronización está en pausa',
    { plan: planJson(entitlements, organizationId) },
  );
}

/// Detrás de `deviceAuth`: corta con 402 si el plan de la organización venció.
export const requireActivePlan: RequestHandler = (req, _res, next) => {
  const device = requireDevice(req.device);
  if (device.entitlements.state === 'lapsed') {
    throw subscriptionInactive(device.entitlements, device.organizationId);
  }
  next();
};
