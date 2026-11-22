import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { requireDevice } from '../auth/deviceAuth.js';
import {
  organizationIdsOf,
  planFromSubscriber,
  WebhookBody,
  type SubscriberFetcher,
} from '../billing/revenuecat.js';
import type { Db } from '../db.js';
import { HttpError, unauthorized } from '../errors.js';
import { entitlementsOf, planJson } from '../plans.js';
import { Prisma } from '../../generated/prisma/client.js';
import { requireBranchAdmin } from './branch.js';

export interface BillingConfig {
  /// Lee el suscriptor en RevenueCat (`REVENUECAT_SECRET_KEY`).
  fetchSubscriber?: SubscriberFetcher;
  /// Valor exacto del header `Authorization` del webhook.
  webhookSecret?: string;
}

const notConfigured = () =>
  new HttpError(503, 'billing_not_configured', 'El cobro en la app no está configurado');

/// Recalcula el plan de la organización desde RevenueCat. Un plan manual
/// (pilotos) solo se reemplaza si hay una compra vigente en la tienda.
export async function syncStorePlan(
  db: Db,
  fetchSubscriber: SubscriberFetcher,
  organizationId: string,
): Promise<void> {
  const org = await db.organization.findUnique({ where: { id: organizationId } });
  if (!org) return;
  const store = planFromSubscriber(await fetchSubscriber(organizationId), new Date());
  if (!store) return;
  if (org.billingSource === 'manual' && !store.active) return;
  await db.organization.update({
    where: { id: org.id },
    data: {
      plan: store.plan,
      subscriptionStatus: store.subscriptionStatus,
      currentPeriodEnd: store.currentPeriodEnd,
      billingSource: 'store',
    },
  });
}

function sameSecret(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/// Webhook de RevenueCat (sin auth de dispositivo; la valida el secreto).
export function billingWebhookRouter(db: Db, config: BillingConfig): Router {
  const router = Router();

  router.post('/revenuecat', async (req, res) => {
    const { fetchSubscriber, webhookSecret } = config;
    if (!fetchSubscriber || !webhookSecret) throw notConfigured();
    if (!sameSecret(req.header('authorization'), webhookSecret)) throw unauthorized();
    const { event } = WebhookBody.parse(req.body);

    const orgIds = organizationIdsOf(event);
    const known = await db.organization.findMany({
      where: { id: { in: orgIds } },
      select: { id: true },
    });
    try {
      // Primero se registra: un reenvío del mismo evento no se reprocesa.
      await db.billingEvent.create({
        data: {
          id: event.id,
          type: event.type,
          organizationId: known[0]?.id ?? null,
          payload: req.body as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        res.json({ ok: true, duplicate: true });
        return;
      }
      throw err;
    }
    for (const { id } of known) await syncStorePlan(db, fetchSubscriber, id);
    // Una org desconocida (otro ambiente, compra de prueba) no es error:
    // RevenueCat reintentaría para siempre.
    res.json({ ok: true, organizations: known.length });
  });

  return router;
}

/// Tras comprar o restaurar en la app: recalcula al momento. Detrás de
/// `deviceAuth` pero no de `requireActivePlan` (un plan vencido renueva aquí).
export function billingDeviceRouter(db: Db, config: BillingConfig): Router {
  const router = Router();

  router.post('/sync', async (req, res) => {
    const device = requireDevice(req.device);
    await requireBranchAdmin(db, device, req.header('x-boba-user'));
    if (!config.fetchSubscriber) throw notConfigured();
    await syncStorePlan(db, config.fetchSubscriber, device.organizationId);
    const org = await db.organization.findUniqueOrThrow({
      where: { id: device.organizationId },
    });
    res.json({ plan: planJson(entitlementsOf(org, new Date()), org.id) });
  });

  return router;
}
