import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import { noopNotifier, type BranchNotifier } from '../realtime/branchNotifier.js';
import { newPairingCode, normalizePairingCode, sha256 } from '../tokens.js';

export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

const NewOrganization = z.object({ name: z.string().trim().min(1) });
const NewBranch = z.object({
  name: z.string().trim().min(1),
  timezoneId: z.string().min(1).optional(),
  currencyCode: z.string().length(3).optional(),
});

/// Alta de organizaciones, sucursales y códigos de emparejamiento. Protegido
/// con `adminAuth` (el panel del dueño llegará después).
export function adminRouter(db: Db, notifier: BranchNotifier = noopNotifier): Router {
  const router = Router();

  router.post('/organizations', async (req, res) => {
    const { name } = NewOrganization.parse(req.body);
    const org = await db.organization.create({ data: { name } });
    res.status(201).json(org);
  });

  router.post('/organizations/:orgId/branches', async (req, res) => {
    const body = NewBranch.parse(req.body);
    const org = await db.organization.findUnique({ where: { id: req.params.orgId } });
    if (!org) throw notFound('Organización no encontrada');
    const branch = await db.branch.create({ data: { ...body, organizationId: org.id } });
    res.status(201).json(branch);
  });

  /// El código en claro solo aparece en esta respuesta (se guarda su hash).
  router.post('/branches/:branchId/pairing-codes', async (req, res) => {
    const branch = await db.branch.findUnique({ where: { id: req.params.branchId } });
    if (!branch) throw notFound('Sucursal no encontrada');
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    await db.devicePairingCode.create({
      data: {
        branchId: branch.id,
        codeHash: sha256(normalizePairingCode(code)),
        expiresAt,
      },
    });
    res.status(201).json({ code, expiresAt, branchId: branch.id });
  });

  router.get('/branches/:branchId/devices', async (req, res) => {
    const devices = await db.device.findMany({
      where: { branchId: req.params.branchId },
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
    const device = await db.device.findUnique({ where: { id: req.params.id } });
    if (!device) throw notFound('Dispositivo no encontrado');
    const revoked = await db.device.update({
      where: { id: device.id },
      data: { revokedAt: device.revokedAt ?? new Date() },
      select: { id: true, revokedAt: true },
    });
    // Corta su socket de tiempo real (cierre 4401: no reconecta).
    notifier.disconnectDevice(device.id);
    res.json(revoked);
  });

  return router;
}
