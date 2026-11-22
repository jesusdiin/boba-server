import { randomInt } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { requireDevice, type DeviceContext } from '../auth/deviceAuth.js';
import type { Db } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { codeEmail, type Mailer } from '../mail/mailer.js';
import { stateOf } from '../sync/rules.js';
import { safeEqual, sha256 } from '../tokens.js';
import { requireBranchAdmin } from './branch.js';
import { PairingThrottle } from './devices.js';

type Purpose = 'link_email' | 'reset_pin';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const Email = z
  .email()
  .max(254)
  .transform((e) => e.trim().toLowerCase());
const Code = z.string().trim().regex(/^\d{6}$/, 'El código tiene 6 dígitos');

const codeHash = (id: string, code: string) => sha256(`${id}:${code}`);

/// "jesus@gmail.com" → "j•••@gmail.com".
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

export interface AccountOptions {
  mailer: Mailer;
  /// Envíos por usuario (3 cada 15 min por defecto).
  sendThrottle?: PairingThrottle;
}

/// Cuenta del Dueño: su correo verificado y el cambio de PIN con un código
/// enviado a ese correo. Autenticado con el token del equipo.
export function accountRouter(
  db: Db,
  { mailer, sendThrottle = new PairingThrottle(3, 15 * 60 * 1000) }: AccountOptions,
): Router {
  const router = Router();

  async function sendCode(
    device: DeviceContext,
    { userId, email, purpose }: { userId: string; email: string; purpose: Purpose },
  ): Promise<void> {
    sendThrottle.ensureAllowed(`user:${userId}`);
    sendThrottle.recordFailure(`user:${userId}`);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const org = await db.organization.findUniqueOrThrow({
      where: { id: device.organizationId },
      select: { name: true },
    });
    await db.$transaction(async (tx) => {
      // Solo vale el último código enviado.
      await tx.emailCode.updateMany({
        where: { userId, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      const row = await tx.emailCode.create({
        data: {
          organizationId: device.organizationId,
          userId,
          email,
          purpose,
          codeHash: '',
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      });
      await tx.emailCode.update({
        where: { id: row.id },
        data: { codeHash: codeHash(row.id, code) },
      });
    });
    await mailer.send(codeEmail(email, { code, purpose, businessName: org.name }));
  }

  /// Consume el código vigente de [userId] o falla (y cuenta el intento).
  async function checkCode(
    device: DeviceContext,
    { userId, purpose, code }: { userId: string; purpose: Purpose; code: string },
  ) {
    const row = await db.emailCode.findFirst({
      where: { userId, purpose, consumedAt: null, organizationId: device.organizationId },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) throw new HttpError(400, 'invalid_code', 'Código incorrecto; pide uno nuevo');
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new HttpError(400, 'code_expired', 'El código venció; pide uno nuevo');
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      throw new HttpError(429, 'too_many_attempts', 'Demasiados intentos; pide un código nuevo');
    }
    if (!safeEqual(row.codeHash, codeHash(row.id, code))) {
      await db.emailCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw new HttpError(400, 'invalid_code', 'Código incorrecto');
    }
    const consumed = await db.emailCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) {
      throw new HttpError(400, 'invalid_code', 'Código incorrecto; pide uno nuevo');
    }
    return row;
  }

  // --- Correo del Dueño (con sesión de un Dueño: `X-Boba-User`) --------

  const ownerOf = async (device: DeviceContext, userId: string | undefined) => {
    await requireBranchAdmin(db, device, userId, 'manageOrganization');
    return userId!;
  };

  const accountJson = (a: { email: string; verifiedAt: Date } | null) =>
    a ? { email: a.email, verifiedAt: a.verifiedAt } : null;

  router.get('/email', async (req, res) => {
    const device = requireDevice(req.device);
    const userId = await ownerOf(device, req.header('x-boba-user'));
    const account = await db.ownerAccount.findUnique({ where: { userId } });
    res.json({ account: accountJson(account) });
  });

  router.post('/email/start', async (req, res) => {
    const device = requireDevice(req.device);
    const userId = await ownerOf(device, req.header('x-boba-user'));
    const { email } = z.object({ email: Email }).parse(req.body);
    const taken = await db.ownerAccount.findUnique({ where: { email } });
    if (taken && taken.userId !== userId) {
      throw new HttpError(409, 'email_taken', 'Ese correo ya es de otro Dueño');
    }
    await sendCode(device, { userId, email, purpose: 'link_email' });
    res.status(202).json({ email });
  });

  router.post('/email/verify', async (req, res) => {
    const device = requireDevice(req.device);
    const userId = await ownerOf(device, req.header('x-boba-user'));
    const body = z.object({ email: Email, code: Code }).parse(req.body);
    const row = await checkCode(device, { userId, purpose: 'link_email', code: body.code });
    if (row.email !== body.email) {
      throw new HttpError(400, 'invalid_code', 'El código es de otro correo; pide uno nuevo');
    }
    const taken = await db.ownerAccount.findUnique({ where: { email: row.email } });
    if (taken && taken.userId !== userId) {
      throw new HttpError(409, 'email_taken', 'Ese correo ya es de otro Dueño');
    }
    const now = new Date();
    const account = await db.ownerAccount.upsert({
      where: { userId },
      create: { organizationId: device.organizationId, userId, email: row.email, verifiedAt: now },
      update: { email: row.email, verifiedAt: now },
    });
    res.json({ account: accountJson(account) });
  });

  // --- Cambiar el PIN olvidado (sin sesión: nadie ha entrado) ------------

  /// El usuario es un Dueño activo de la sucursal del equipo y tiene correo.
  async function ownerAccountFor(device: DeviceContext, userId: string) {
    if (device.mode === 'kiosk') {
      throw new HttpError(403, 'kiosk_forbidden', 'Un kiosco no cambia PINs');
    }
    const user = await stateOf(db, device.branchId, 'user', userId);
    const row = user?.row as { isActive?: unknown } | null | undefined;
    if (!user || row?.isActive === false || user.status !== 'owner') {
      throw notFound('Dueño no encontrado en la sucursal');
    }
    const account = await db.ownerAccount.findUnique({ where: { userId } });
    if (!account || account.organizationId !== device.organizationId) {
      throw new HttpError(404, 'no_account', 'Este Dueño no tiene correo verificado');
    }
    return account;
  }

  const UserBody = z.object({ userId: z.uuid() });

  router.post('/pin-reset/start', async (req, res) => {
    const device = requireDevice(req.device);
    const { userId } = UserBody.parse(req.body);
    const account = await ownerAccountFor(device, userId);
    await sendCode(device, { userId, email: account.email, purpose: 'reset_pin' });
    res.status(202).json({ maskedEmail: maskEmail(account.email) });
  });

  router.post('/pin-reset/verify', async (req, res) => {
    const device = requireDevice(req.device);
    const body = UserBody.extend({ code: Code }).parse(req.body);
    await ownerAccountFor(device, body.userId);
    await checkCode(device, { userId: body.userId, purpose: 'reset_pin', code: body.code });
    res.json({ ok: true });
  });

  return router;
}
