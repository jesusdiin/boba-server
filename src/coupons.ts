import { randomInt } from 'node:crypto';

import { z } from 'zod';

import { Prisma, type Coupon, type Organization } from '../generated/prisma/client.js';
import { HttpError } from './errors.js';
import { entitlementsOf, LimitOverrides, type PlanName } from './plans.js';
import type { Tx } from './sync/rules.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/// Sin 0/O/1/I: se dicta y se teclea sin confusión.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/// "boba xk3p-7q2m " → "BOBA-XK3P-7Q2M" (mayúsculas, sin espacios).
export const normalizeCoupon = (code: string): string =>
  code.toUpperCase().replace(/\s+/g, '');

/// `BOBA-XXXX-XXXX`.
export function newCouponCode(): string {
  const part = () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `BOBA-${part()}-${part()}`;
}

/// Código propio del operador ("CAFE2026").
export const CustomCode = z
  .string()
  .transform(normalizeCoupon)
  .pipe(z.string().regex(/^[A-Z0-9-]{4,32}$/, 'Solo letras, números y guiones (4 a 32)'));

/// Lo que da un cupón al crearlo desde el panel.
export const NewCoupon = z.object({
  plan: z.enum(['pro', 'max']),
  /// `null` = sin vencimiento.
  durationDays: z.number().int().min(1).max(3650).nullable(),
  /// `null` = ilimitado.
  maxRedemptions: z.number().int().min(1).max(100_000).nullable().default(1),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  limitOverrides: LimitOverrides.nullable().optional(),
  note: z.string().trim().max(200).optional(),
  /// Código propio (solo para uno); sin él se generan.
  code: CustomCode.optional(),
  /// Cuántos generar (lote).
  count: z.number().int().min(1).max(200).default(1),
});
export type NewCoupon = z.infer<typeof NewCoupon>;

const PLAN_RANK: Record<PlanName, number> = { pro: 1, max: 2 };

const fail = (status: number, code: string, message: string) =>
  new HttpError(status, code, message);

/// Canjea [code] para la organización dentro de [tx]. Lanza `HttpError`
/// con el motivo; si sale bien, devuelve la organización actualizada.
export async function redeemCoupon(
  tx: Tx,
  organizationId: string,
  code: string,
  now: Date,
): Promise<{ org: Organization; coupon: Coupon }> {
  const normalized = normalizeCoupon(code);
  // Bloquea el cupón (canjes simultáneos) y la organización.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM coupons WHERE code = ${normalized} FOR UPDATE`;
  const coupon = locked[0]
    ? await tx.coupon.findUnique({ where: { id: locked[0].id } })
    : null;
  if (!coupon || coupon.disabledAt) {
    throw fail(404, 'invalid_coupon', 'El código no existe');
  }
  if (coupon.expiresAt && coupon.expiresAt <= now) {
    throw fail(410, 'coupon_expired', 'El código ya venció');
  }
  if (coupon.maxRedemptions !== null && coupon.redemptionCount >= coupon.maxRedemptions) {
    throw fail(409, 'coupon_exhausted', 'Ese código ya no tiene usos');
  }
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const used = await tx.couponRedemption.findUnique({
    where: { couponId_organizationId: { couponId: coupon.id, organizationId } },
  });
  if (used) throw fail(409, 'coupon_already_used', 'Ya usaste ese código');

  const current = entitlementsOf(org, now);
  const running = current.state !== 'lapsed';
  if (org.billingSource === 'store' && running && org.subscriptionStatus !== 'canceled') {
    throw fail(
      409,
      'store_subscription',
      'Ya tienes una suscripción en la tienda; cancélala primero o escríbenos',
    );
  }
  if (running && PLAN_RANK[org.plan] > PLAN_RANK[coupon.plan]) {
    throw fail(409, 'higher_plan', 'Ya tienes un plan mayor vigente');
  }
  const unlimited = running && org.currentPeriodEnd === null;
  // Un cupón con días no reemplaza una cortesía sin vencimiento.
  if (unlimited && coupon.durationDays !== null) {
    throw fail(409, 'already_unlimited', 'Ya tienes una cortesía sin vencimiento');
  }

  // Los días se suman al final del periodo vigente del mismo plan.
  let periodEnd: Date | null = null;
  if (coupon.durationDays !== null) {
    const sameRunning =
      org.plan === coupon.plan && org.currentPeriodEnd && org.currentPeriodEnd > now;
    const from = sameRunning ? org.currentPeriodEnd!.getTime() : now.getTime();
    periodEnd = new Date(from + coupon.durationDays * DAY_MS);
  }

  const updated = await tx.organization.update({
    where: { id: org.id },
    data: {
      plan: coupon.plan,
      subscriptionStatus: 'active',
      currentPeriodEnd: periodEnd,
      billingSource: 'manual',
      ...(coupon.limitOverrides === null
        ? {}
        : { limitOverrides: coupon.limitOverrides as Prisma.InputJsonValue }),
    },
  });
  await tx.couponRedemption.create({
    data: {
      couponId: coupon.id,
      organizationId: org.id,
      redeemedAt: now,
      previousPlan: {
        plan: org.plan,
        status: org.subscriptionStatus,
        periodEnd: org.currentPeriodEnd?.toISOString() ?? null,
        billingSource: org.billingSource,
        limitOverrides: org.limitOverrides ?? null,
      } as Prisma.InputJsonValue,
      resultingPeriodEnd: periodEnd,
    },
  });
  await tx.coupon.update({
    where: { id: coupon.id },
    data: { redemptionCount: { increment: 1 } },
  });
  return { org: updated, coupon };
}

/// Estado de un cupón para el panel.
export function couponStatus(
  c: Coupon,
  now: Date,
): 'active' | 'used' | 'disabled' | 'expired' {
  if (c.disabledAt) return 'disabled';
  if (c.expiresAt && c.expiresAt <= now) return 'expired';
  if (c.maxRedemptions !== null && c.redemptionCount >= c.maxRedemptions) return 'used';
  return 'active';
}

export function couponJson(c: Coupon, now: Date) {
  return {
    id: c.id,
    code: c.code,
    plan: c.plan,
    durationDays: c.durationDays,
    limitOverrides: c.limitOverrides,
    maxRedemptions: c.maxRedemptions,
    redemptionCount: c.redemptionCount,
    expiresAt: c.expiresAt,
    kind: c.kind,
    batchId: c.batchId,
    note: c.note,
    disabledAt: c.disabledAt,
    createdAt: c.createdAt,
    status: couponStatus(c, now),
  };
}
