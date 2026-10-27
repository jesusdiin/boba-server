import { Router } from 'express';

import { requireDevice, type DeviceContext } from '../auth/deviceAuth.js';
import type { Db } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { createPairingCode } from '../pairing.js';
import { noopNotifier, type BranchNotifier } from '../realtime/branchNotifier.js';
import { roleCan } from '../sync/permissions.js';
import { stateOf } from '../sync/rules.js';

const forbidden = (code: string, message: string) => new HttpError(403, code, message);

/// Administración de la sucursal desde la app: el dispositivo se autentica
/// con su token y el usuario de la sesión viaja en `X-Boba-User`; tiene que
/// ser admin **de la sucursal del token** (según los usuarios sincronizados).
async function requireBranchAdmin(
  db: Db,
  device: DeviceContext,
  userId: string | undefined,
): Promise<void> {
  if (device.mode === 'kiosk') {
    throw forbidden('kiosk_forbidden', 'Un kiosco no administra la sucursal');
  }
  const user = userId ? await stateOf(db, device.branchId, 'user', userId) : null;
  const row = user?.row as { isActive?: unknown } | null | undefined;
  if (!user || row?.isActive === false) {
    throw forbidden('unknown_user', 'Usuario desconocido o inactivo en la sucursal');
  }
  if (!roleCan(user.status ?? '', 'manageDevices')) {
    throw forbidden('forbidden', `El rol ${user.status} no administra dispositivos`);
  }
}

export function branchRouter(db: Db, notifier: BranchNotifier = noopNotifier): Router {
  const router = Router();

  router.use(async (req, _res, next) => {
    await requireBranchAdmin(db, requireDevice(req.device), req.header('x-boba-user'));
    next();
  });

  router.post('/pairing-codes', async (req, res) => {
    const device = requireDevice(req.device);
    res.status(201).json(await createPairingCode(db, device.branchId));
  });

  router.get('/devices', async (req, res) => {
    const device = requireDevice(req.device);
    const devices = await db.device.findMany({
      where: { branchId: device.branchId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        mode: true,
        lastSeenAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
    res.json({ devices });
  });

  router.post('/devices/:id/revoke', async (req, res) => {
    const self = requireDevice(req.device);
    const target = await db.device.findUnique({ where: { id: req.params.id } });
    if (!target || target.branchId !== self.branchId) {
      throw notFound('Dispositivo no encontrado');
    }
    if (target.id === self.id) {
      throw new HttpError(409, 'cannot_revoke_self', 'No puedes desconectar este dispositivo');
    }
    const revoked = await db.device.update({
      where: { id: target.id },
      data: { revokedAt: target.revokedAt ?? new Date() },
      select: { id: true, revokedAt: true },
    });
    notifier.disconnectDevice(target.id);
    res.json(revoked);
  });

  return router;
}
