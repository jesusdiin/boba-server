import { z } from 'zod';

import { Prisma, type Organization } from '../generated/prisma/client.js';
import type { Db } from './db.js';
import { notFound } from './errors.js';
import { LimitOverrides } from './plans.js';

const PlanName = z.enum(['pro', 'max']);
const Status = z.enum(['trialing', 'active', 'past_due', 'canceled']);

/// Cambio manual del plan (API admin y panel del operador).
export const PlanPatch = z
  .object({
    plan: PlanName,
    subscriptionStatus: Status,
    /// ISO 8601; `null` = sin vencimiento.
    currentPeriodEnd: z.iso.datetime({ offset: true }).nullable(),
    limitOverrides: LimitOverrides.nullable(),
    /// `manual` evita que la tienda lo cambie (salvo una compra vigente).
    billingSource: z.enum(['manual', 'store']),
  })
  .partial();
export type PlanPatch = z.infer<typeof PlanPatch>;

export async function updateOrgPlan(
  db: Db,
  organizationId: string,
  body: PlanPatch,
): Promise<Organization> {
  const org = await db.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw notFound('Organización no encontrada');
  return db.organization.update({
    where: { id: org.id },
    data: {
      plan: body.plan,
      subscriptionStatus: body.subscriptionStatus,
      currentPeriodEnd:
        body.currentPeriodEnd === undefined
          ? undefined
          : body.currentPeriodEnd && new Date(body.currentPeriodEnd),
      limitOverrides:
        body.limitOverrides === undefined ? undefined : (body.limitOverrides ?? Prisma.DbNull),
      billingSource: body.billingSource,
    },
  });
}
