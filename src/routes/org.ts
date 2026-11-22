import { Router } from 'express';
import { z } from 'zod';

import { requireDevice } from '../auth/deviceAuth.js';
import type { Db } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import {
  createPairingCode,
  ensureCanAddBranch,
  ensureCanAddDevice,
  nextFolioPrefix,
  pairResponse,
} from '../pairing.js';
import { CLOSE_MOVED, noopNotifier, type BranchNotifier } from '../realtime/branchNotifier.js';
import { copyCatalog } from '../sync/branchSeed.js';
import { syncOwnersInto } from '../sync/ownerReplication.js';
import { requireBranchAdmin } from './branch.js';

const NewBranch = z.object({
  name: z.string().trim().min(1).max(80),
  /// Copiar el catálogo de la sucursal del equipo (si no, arranca vacía).
  copyCatalog: z.boolean().default(true),
});

/// Administración de la organización desde la app (solo el Dueño): sus
/// sucursales y los códigos para sumarles equipos. El Dueño se valida en la
/// sucursal del token (`X-Boba-User`), donde existe como en todas.
export function orgRouter(db: Db, notifier: BranchNotifier = noopNotifier): Router {
  const router = Router();

  router.use(async (req, _res, next) => {
    await requireBranchAdmin(
      db,
      requireDevice(req.device),
      req.header('x-boba-user'),
      'manageOrganization',
    );
    next();
  });

  router.get('/branches', async (req, res) => {
    const device = requireDevice(req.device);
    const branches = await db.branch.findMany({
      where: { organizationId: device.organizationId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        createdAt: true,
        _count: { select: { devices: { where: { revokedAt: null } } } },
      },
    });
    res.json({
      branches: branches.map((b) => ({
        id: b.id,
        name: b.name,
        createdAt: b.createdAt,
        devices: b._count.devices,
        current: b.id === device.branchId,
      })),
    });
  });

  /// Sucursal nueva con los Dueños (y, si se pide, el catálogo de la
  /// sucursal del equipo) y un código para emparejar su primer equipo.
  router.post('/branches', async (req, res) => {
    const device = requireDevice(req.device);
    const body = NewBranch.parse(req.body);
    const { branch, pairingCode, last } = await db.$transaction(
      async (tx) => {
        // Dos altas simultáneas no rebasan el límite del plan.
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${device.organizationId}::uuid FOR UPDATE`;
        await ensureCanAddBranch(tx, device.organizationId);
        const source = await tx.branch.findUniqueOrThrow({ where: { id: device.branchId } });
        const branch = await tx.branch.create({
          data: {
            organizationId: device.organizationId,
            name: body.name,
            timezoneId: source.timezoneId,
            currencyCode: source.currencyCode,
          },
        });
        let last = await syncOwnersInto(tx, device.organizationId, branch.id, device.id);
        if (body.copyCatalog) {
          const copied = await copyCatalog(tx, {
            organizationId: device.organizationId,
            fromBranchId: source.id,
            toBranchId: branch.id,
            deviceId: device.id,
          });
          last = copied.last ?? last;
        }
        return { branch, pairingCode: await createPairingCode(tx, branch.id), last };
      },
      { timeout: 60_000 },
    );
    if (last !== null) notifier.notify(branch.id, last);
    res.status(201).json({
      branch: { id: branch.id, name: branch.name, createdAt: branch.createdAt },
      pairingCode,
    });
  });

  /// Mueve este equipo a otra sucursal de la organización (mismo token). El
  /// equipo debe tener su turno cerrado; la app además exige no tener nada
  /// sin subir. Responde como el emparejamiento para que la app adopte la
  /// sucursal nueva.
  router.post('/devices/self/move', async (req, res) => {
    const device = requireDevice(req.device);
    const { branchId } = z.object({ branchId: z.uuid() }).parse(req.body);
    if (branchId === device.branchId) {
      throw new HttpError(409, 'same_branch', 'Este equipo ya es de esa sucursal');
    }
    const result = await db.$transaction(async (tx) => {
      const target = await tx.branch.findUnique({ where: { id: branchId } });
      if (!target || target.organizationId !== device.organizationId) {
        throw notFound('Sucursal no encontrada');
      }
      const openShift = await tx.aggregateState.findFirst({
        where: {
          branchId: device.branchId,
          aggregateType: 'shift',
          status: 'open',
          row: { path: ['deviceId'], equals: device.id },
        },
        select: { aggregateId: true },
      });
      if (openShift) {
        throw new HttpError(409, 'open_shift', 'Cierra el turno de este equipo antes de moverlo');
      }
      await tx.$queryRaw`SELECT id FROM branches WHERE id = ${branchId}::uuid FOR UPDATE`;
      const moved = await tx.device.update({
        where: { id: device.id },
        data: { branchId, folioPrefix: await nextFolioPrefix(tx, branchId) },
      });
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: device.organizationId },
      });
      return { moved, target, orgName: org.name };
    });
    // Su socket era de la otra sucursal: que reconecte.
    notifier.disconnectDevice(device.id, CLOSE_MOVED, 'moved');
    const token = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    res.json(pairResponse(result.moved, result.target, token, result.orgName));
  });

  router.post('/branches/:id/pairing-codes', async (req, res) => {
    const device = requireDevice(req.device);
    const branch = await db.branch.findUnique({ where: { id: req.params.id } });
    if (!branch || branch.organizationId !== device.organizationId) {
      throw notFound('Sucursal no encontrada');
    }
    await ensureCanAddDevice(db, device.organizationId);
    res.status(201).json(await createPairingCode(db, branch.id));
  });

  return router;
}
