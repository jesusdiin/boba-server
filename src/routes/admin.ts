import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import {
  noopNotifier,
  notifyPlanChanged,
  type BranchNotifier,
} from '../realtime/branchNotifier.js';
import { hashPassword, newOperatorPassword } from '../auth/operatorAuth.js';
import { promoteAdminsToOwners } from '../sync/ownerReplication.js';
import { rebuildProjections } from '../sync/rules.js';
import { createPairingCode, ensureCanAddBranch } from '../pairing.js';
import { PlanPatch, updateOrgPlan } from '../orgPlan.js';
import { entitlementsOf, planJson } from '../plans.js';

const NewOrganization = z.object({
  name: z.string().trim().min(1),
  plan: z.enum(['pro', 'max']).optional(),
});

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
    const { name, plan } = NewOrganization.parse(req.body);
    const org = await db.organization.create({ data: { name, plan } });
    res.status(201).json(org);
  });

  /// Plan, estado y uso (equipos activos y sucursales).
  router.get('/organizations/:orgId', async (req, res) => {
    const org = await db.organization.findUnique({ where: { id: req.params.orgId } });
    if (!org) throw notFound('Organización no encontrada');
    const [branches, devices] = await Promise.all([
      db.branch.findMany({
        where: { organizationId: org.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      }),
      db.device.count({ where: { organizationId: org.id, revokedAt: null } }),
    ]);
    res.json({
      id: org.id,
      name: org.name,
      createdAt: org.createdAt,
      plan: planJson(entitlementsOf(org, new Date())),
      billingSource: org.billingSource,
      usage: { branches: branches.length, devices },
      branches,
    });
  });

  router.patch('/organizations/:orgId/plan', async (req, res) => {
    const updated = await updateOrgPlan(db, req.params.orgId, PlanPatch.parse(req.body));
    await notifyPlanChanged(db, notifier, updated.id);
    res.json({ id: updated.id, plan: planJson(entitlementsOf(updated, new Date())) });
  });

  router.post('/organizations/:orgId/branches', async (req, res) => {
    const body = NewBranch.parse(req.body);
    const org = await db.organization.findUnique({ where: { id: req.params.orgId } });
    if (!org) throw notFound('Organización no encontrada');
    await ensureCanAddBranch(db, org.id);
    const branch = await db.branch.create({ data: { ...body, organizationId: org.id } });
    res.status(201).json(branch);
  });

  /// El código en claro solo aparece en esta respuesta (se guarda su hash).
  router.post('/branches/:branchId/pairing-codes', async (req, res) => {
    const branch = await db.branch.findUnique({ where: { id: req.params.branchId } });
    if (!branch) throw notFound('Sucursal no encontrada');
    const { code, expiresAt } = await createPairingCode(db, branch.id);
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

  /// Reconstruye las proyecciones desde el log (datos previos a la Fase 4 o
  /// tras un cambio en las reglas de proyección).
  router.post('/projections/rebuild', async (req, res) => {
    const branchId = z.uuid().optional().parse(req.body?.branchId);
    const events = await rebuildProjections(db, branchId);
    res.json({ events });
  });

  /// Alta de un operador del panel (boba_admin). La contraseña inicial solo
  /// sale en esta respuesta; se cambia desde el panel.
  router.post('/operators', async (req, res) => {
    const body = z
      .object({
        email: z.string().trim().toLowerCase().email(),
        name: z.string().trim().min(1),
      })
      .parse(req.body);
    const password = newOperatorPassword();
    const operator = await db.operator.upsert({
      where: { email: body.email },
      create: { ...body, passwordHash: await hashPassword(password) },
      // Ya existía: se reactiva con contraseña nueva (recuperar acceso).
      update: {
        name: body.name,
        passwordHash: await hashPassword(password),
        disabledAt: null,
      },
    });
    await db.operatorSession.deleteMany({ where: { operatorId: operator.id } });
    res.status(201).json({ id: operator.id, email: operator.email, password });
  });

  /// Migración al rol Dueño: los admins activos pasan a `owner` y se
  /// replican a todas las sucursales de su organización.
  router.post('/users/promote-admins', async (req, res) => {
    const organizationId = z.uuid().optional().parse(req.body?.organizationId);
    res.json(await promoteAdminsToOwners(db, notifier, organizationId));
  });

  return router;
}
