import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import {
  clearSessionCookie,
  createSession,
  hashPassword,
  readCookie,
  requireOperator,
  SESSION_COOKIE,
  setSessionCookie,
  verifyPassword,
} from '../auth/operatorAuth.js';
import type { Db } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import {
  auditJson,
  listOrganizations,
  organizationDetail,
  systemStats,
  type Prices,
  type Segment,
} from '../ops/stats.js';
import { couponJson, NewCoupon, newCouponCode, normalizeCoupon } from '../coupons.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PlanPatch, updateOrgPlan } from '../orgPlan.js';
import { createPairingCode } from '../pairing.js';
import { entitlementsOf, planJson } from '../plans.js';
import { noopNotifier, type BranchNotifier } from '../realtime/branchNotifier.js';
import { promoteAdminsToOwners } from '../sync/ownerReplication.js';
import { rebuildProjections } from '../sync/rules.js';
import { sha256 } from '../tokens.js';
import { PairingThrottle } from './devices.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const Login = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

const NewPassword = z.object({
  current: z.string().min(1),
  next: z.string().min(10, 'Usa al menos 10 caracteres').max(200),
});

const ListQuery = z.object({
  q: z.string().trim().optional(),
  segment: z
    .enum(['paid', 'trial', 'courtesy', 'canceled', 'grace', 'lapsed'])
    .optional(),
  plan: z.enum(['pro', 'max']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const ExtendTrial = z.object({ days: z.number().int().min(1).max(90) });

export interface OpsConfig {
  prices: Prices;
  throttle?: PairingThrottle;
}

/// API del panel del operador (boba_admin): estadísticas del sistema,
/// negocios y acciones de soporte. Sesión por cookie (`operatorAuth.ts`);
/// cada acción queda en `operator_audit`.
export function opsRouter(
  db: Db,
  notifier: BranchNotifier = noopNotifier,
  { prices, throttle = new PairingThrottle(10, 15 * 60 * 1000) }: OpsConfig,
): Router {
  const router = Router();

  const audit = (
    operatorId: string,
    action: string,
    organizationId: string | null,
    details: Record<string, unknown> = {},
  ) =>
    db.operatorAudit.create({
      data: { operatorId, action, organizationId, details: details as object },
    });

  // --- Sesión -------------------------------------------------------------------

  router.post('/login', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    const body = Login.parse(req.body);
    throttle.ensureAllowed(ip);
    throttle.ensureAllowed(`email:${body.email}`);
    const operator = await db.operator.findUnique({ where: { email: body.email } });
    const ok =
      operator !== null &&
      operator.disabledAt === null &&
      (await verifyPassword(body.password, operator.passwordHash));
    if (!operator || !ok) {
      throttle.recordFailure(ip);
      throttle.recordFailure(`email:${body.email}`);
      throw new HttpError(401, 'invalid_credentials', 'Correo o contraseña incorrectos');
    }
    setSessionCookie(req, res, await createSession(db, operator.id));
    await audit(operator.id, 'login', null, { ip });
    res.json({ id: operator.id, email: operator.email, name: operator.name });
  });

  router.post('/logout', async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token)
      await db.operatorSession.deleteMany({ where: { tokenHash: sha256(token) } });
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  router.use(requireOperator(db));

  router.get('/me', (req, res) => {
    res.json(req.operator);
  });

  router.post('/me/password', async (req, res) => {
    const me = req.operator!;
    const body = NewPassword.parse(req.body);
    const operator = await db.operator.findUniqueOrThrow({ where: { id: me.id } });
    if (!(await verifyPassword(body.current, operator.passwordHash))) {
      throw new HttpError(403, 'invalid_credentials', 'La contraseña actual no coincide');
    }
    await db.operator.update({
      where: { id: me.id },
      data: { passwordHash: await hashPassword(body.next) },
    });
    // Cierra las demás sesiones (esta sigue).
    const token = readCookie(req, SESSION_COOKIE) ?? '';
    await db.operatorSession.deleteMany({
      where: { operatorId: me.id, NOT: { tokenHash: sha256(token) } },
    });
    await audit(me.id, 'password_changed', null);
    res.json({ ok: true });
  });

  // --- Lectura ------------------------------------------------------------------

  router.get('/stats', async (_req, res) => {
    res.json(await systemStats(db, prices, new Date()));
  });

  router.get('/organizations', async (req, res) => {
    const query = ListQuery.parse(req.query);
    const q = query.q?.toLowerCase();
    // Buscar también por el correo de un Dueño.
    const byEmail = q?.includes('@')
      ? new Set(
          (
            await db.ownerAccount.findMany({
              where: { email: { contains: q } },
              select: { organizationId: true },
            })
          ).map((a) => a.organizationId),
        )
      : new Set<string>();
    const all = (await listOrganizations(db, new Date())).filter(
      (o) =>
        (!q ||
          o.name.toLowerCase().includes(q) ||
          o.id.startsWith(q) ||
          byEmail.has(o.id)) &&
        (!query.segment || o.segment === (query.segment as Segment)) &&
        (!query.plan || o.plan.plan === query.plan),
    );
    const start = (query.page - 1) * query.pageSize;
    res.json({
      total: all.length,
      page: query.page,
      pageSize: query.pageSize,
      organizations: all.slice(start, start + query.pageSize),
    });
  });

  router.get('/organizations/:id', async (req, res) => {
    const detail = await organizationDetail(db, req.params.id, new Date());
    if (!detail) throw notFound('Negocio no encontrado');
    res.json(detail);
  });

  router.get('/audit', async (req, res) => {
    const page = z.coerce.number().int().min(1).default(1).parse(req.query.page);
    const take = 50;
    const [total, rows] = await Promise.all([
      db.operatorAudit.count(),
      db.operatorAudit.findMany({
        orderBy: { at: 'desc' },
        skip: (page - 1) * take,
        take,
        include: { operator: { select: { name: true, email: true } } },
      }),
    ]);
    res.json({ total, page, entries: rows.map(auditJson) });
  });

  // --- Soporte ------------------------------------------------------------------

  router.patch('/organizations/:id/plan', async (req, res) => {
    const body = PlanPatch.parse(req.body);
    const updated = await updateOrgPlan(db, req.params.id, body);
    await audit(req.operator!.id, 'plan_changed', updated.id, body);
    res.json({ id: updated.id, plan: planJson(entitlementsOf(updated, new Date())) });
  });

  /// Más días de prueba desde hoy o desde el fin actual (lo que sea mayor).
  router.post('/organizations/:id/extend-trial', async (req, res) => {
    const { days } = ExtendTrial.parse(req.body);
    const org = await db.organization.findUnique({ where: { id: req.params.id } });
    if (!org) throw notFound('Negocio no encontrado');
    const from = Math.max(Date.now(), org.currentPeriodEnd?.getTime() ?? 0);
    const updated = await db.organization.update({
      where: { id: org.id },
      data: {
        subscriptionStatus: 'trialing',
        currentPeriodEnd: new Date(from + days * DAY_MS),
      },
    });
    await audit(req.operator!.id, 'trial_extended', org.id, {
      days,
      periodEnd: updated.currentPeriodEnd,
    });
    res.json({ id: updated.id, plan: planJson(entitlementsOf(updated, new Date())) });
  });

  router.post('/branches/:id/pairing-codes', async (req, res) => {
    const branch = await db.branch.findUnique({ where: { id: req.params.id } });
    if (!branch) throw notFound('Sucursal no encontrada');
    const code = await createPairingCode(db, branch.id);
    await audit(req.operator!.id, 'pairing_code', branch.organizationId, {
      branchId: branch.id,
    });
    res.status(201).json(code);
  });

  router.post('/devices/:id/revoke', async (req, res) => {
    const device = await db.device.findUnique({ where: { id: req.params.id } });
    if (!device) throw notFound('Equipo no encontrado');
    const revoked = await db.device.update({
      where: { id: device.id },
      data: { revokedAt: device.revokedAt ?? new Date() },
      select: { id: true, revokedAt: true },
    });
    notifier.disconnectDevice(device.id);
    await audit(req.operator!.id, 'device_revoked', device.organizationId, {
      deviceId: device.id,
      name: device.name,
    });
    res.json(revoked);
  });

  router.post('/branches/:id/rebuild-projections', async (req, res) => {
    const branch = await db.branch.findUnique({ where: { id: req.params.id } });
    if (!branch) throw notFound('Sucursal no encontrada');
    const events = await rebuildProjections(db, branch.id);
    await audit(req.operator!.id, 'projections_rebuilt', branch.organizationId, {
      branchId: branch.id,
      events,
    });
    res.json({ events });
  });

  router.post('/organizations/:id/promote-admins', async (req, res) => {
    const org = await db.organization.findUnique({ where: { id: req.params.id } });
    if (!org) throw notFound('Negocio no encontrado');
    const result = await promoteAdminsToOwners(db, notifier, org.id);
    await audit(req.operator!.id, 'admins_promoted', org.id, result);
    res.json(result);
  });

  // --- Cupones ------------------------------------------------------------------

  const CouponQuery = z.object({
    q: z.string().trim().optional(),
    status: z.enum(['active', 'used', 'disabled', 'expired']).optional(),
  });

  router.get('/coupons', async (req, res) => {
    const query = CouponQuery.parse(req.query);
    const now = new Date();
    const q = query.q ? normalizeCoupon(query.q) : undefined;
    const coupons = await db.coupon.findMany({
      where: q
        ? {
            OR: [
              { code: { contains: q } },
              { note: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json({
      coupons: coupons
        .map((c) => couponJson(c, now))
        .filter((c) => !query.status || c.status === query.status),
    });
  });

  router.post('/coupons', async (req, res) => {
    const body = NewCoupon.parse(req.body);
    if (body.code && body.count > 1) {
      throw new HttpError(400, 'invalid_body', 'Un código propio es para un solo cupón');
    }
    if (body.code && (await db.coupon.findUnique({ where: { code: body.code } }))) {
      throw new HttpError(409, 'code_taken', 'Ese código ya existe');
    }
    const batchId = body.count > 1 ? randomUUID() : null;
    const data = (code: string) => ({
      code,
      plan: body.plan,
      durationDays: body.durationDays,
      maxRedemptions: body.maxRedemptions,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      limitOverrides: body.limitOverrides ?? Prisma.DbNull,
      note: body.note || null,
      batchId,
      createdByOperatorId: req.operator!.id,
    });
    const created = [];
    for (let i = 0; i < body.count; i++) {
      // Un choque de código generado es rarísimo: se reintenta.
      for (let attempt = 0; ; attempt++) {
        const code = body.code ?? newCouponCode();
        try {
          created.push(await db.coupon.create({ data: data(code) }));
          break;
        } catch (e) {
          const dup =
            e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
          if (!dup || body.code || attempt >= 5) throw e;
        }
      }
    }
    await audit(req.operator!.id, 'coupon_created', null, {
      count: created.length,
      plan: body.plan,
      durationDays: body.durationDays,
      maxRedemptions: body.maxRedemptions,
      batchId,
      codes: created.slice(0, 20).map((c) => c.code),
    });
    const now = new Date();
    res.status(201).json({ coupons: created.map((c) => couponJson(c, now)) });
  });

  router.get('/coupons/:id', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    const coupon = id.success
      ? await db.coupon.findUnique({
          where: { id: id.data },
          include: {
            redemptions: {
              orderBy: { redeemedAt: 'desc' },
              include: { organization: { select: { id: true, name: true } } },
            },
          },
        })
      : null;
    if (!coupon) throw notFound('Cupón no encontrado');
    res.json({
      ...couponJson(coupon, new Date()),
      redemptions: coupon.redemptions.map((r) => ({
        id: r.id,
        organization: r.organization,
        redeemedAt: r.redeemedAt,
        resultingPeriodEnd: r.resultingPeriodEnd,
      })),
    });
  });

  router.patch('/coupons/:id', async (req, res) => {
    const body = z
      .object({
        disabled: z.boolean().optional(),
        note: z.string().trim().max(200).optional(),
      })
      .parse(req.body);
    const id = z.uuid().safeParse(req.params.id);
    const coupon = id.success
      ? await db.coupon.findUnique({ where: { id: id.data } })
      : null;
    if (!coupon) throw notFound('Cupón no encontrado');
    const updated = await db.coupon.update({
      where: { id: coupon.id },
      data: {
        disabledAt:
          body.disabled === undefined
            ? undefined
            : body.disabled
              ? (coupon.disabledAt ?? new Date())
              : null,
        note: body.note,
      },
    });
    if (body.disabled !== undefined) {
      await audit(
        req.operator!.id,
        body.disabled ? 'coupon_disabled' : 'coupon_enabled',
        null,
        { code: coupon.code },
      );
    }
    res.json(couponJson(updated, new Date()));
  });

  return router;
}
