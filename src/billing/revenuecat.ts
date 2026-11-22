import { z } from 'zod';

import type { PlanName, SubscriptionStatus } from '../plans.js';

/// Integración con RevenueCat, que valida las compras de Google Play y App
/// Store. El `app_user_id` es el id de la organización (la suscripción es del
/// negocio, no de un equipo). El servidor nunca confía en el webhook: ante
/// cualquier evento vuelve a pedir el estado del suscriptor y lo recalcula.

/// Entitlements configurados en RevenueCat; el de más arriba gana.
const ENTITLEMENT_PLANS: [string, PlanName][] = [
  ['max', 'max'],
  ['pro', 'pro'],
];

const isoDate = z.string().nullish();

const Subscriber = z.object({
  entitlements: z
    .record(
      z.string(),
      z.object({ expires_date: isoDate, product_identifier: z.string() }).loose(),
    )
    .default({}),
  subscriptions: z
    .record(
      z.string(),
      z
        .object({
          expires_date: isoDate,
          period_type: z.string().nullish(),
          billing_issues_detected_at: isoDate,
          unsubscribe_detected_at: isoDate,
        })
        .loose(),
    )
    .default({}),
});
export type Subscriber = z.infer<typeof Subscriber>;

export interface StorePlan {
  plan: PlanName;
  subscriptionStatus: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  /// Hay un entitlement vigente (una compra activa).
  active: boolean;
}

const date = (v: string | null | undefined): Date | null => (v ? new Date(v) : null);

/// Plan que corresponde al suscriptor en [now]; `null` si nunca compró nada.
export function planFromSubscriber(subscriber: Subscriber, now: Date): StorePlan | null {
  const candidates = ENTITLEMENT_PLANS.flatMap(([key, plan]) => {
    const e = subscriber.entitlements[key];
    if (!e) return [];
    const end = date(e.expires_date);
    // Sin vencimiento = vitalicio (no se vende, pero RevenueCat lo permite).
    return [{ plan, end, productId: e.product_identifier, active: !end || end > now }];
  });
  if (candidates.length === 0) return null;

  // Uno vigente (el de mayor plan, por el orden) o, si no, el último que venció.
  const chosen =
    candidates.find((c) => c.active) ??
    [...candidates].sort((a, b) => (b.end?.getTime() ?? 0) - (a.end?.getTime() ?? 0))[0]!;

  const sub = subscriber.subscriptions[chosen.productId];
  let subscriptionStatus: SubscriptionStatus;
  if (!chosen.active) subscriptionStatus = 'canceled';
  else if (sub?.billing_issues_detected_at) subscriptionStatus = 'past_due';
  else if (sub?.unsubscribe_detected_at) subscriptionStatus = 'canceled';
  else if (sub?.period_type === 'trial') subscriptionStatus = 'trialing';
  else subscriptionStatus = 'active';

  return {
    plan: chosen.plan,
    subscriptionStatus,
    currentPeriodEnd: chosen.end,
    active: chosen.active,
  };
}

/// Lee el estado actual de un suscriptor (API REST v1 de RevenueCat).
export type SubscriberFetcher = (appUserId: string) => Promise<Subscriber>;

export function revenueCatFetcher(secretKey: string): SubscriberFetcher {
  return async (appUserId) => {
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
      { headers: { authorization: `Bearer ${secretKey}`, accept: 'application/json' } },
    );
    if (!res.ok) throw new Error(`RevenueCat respondió ${res.status}`);
    const body = (await res.json()) as { subscriber?: unknown };
    return Subscriber.parse(body.subscriber ?? {});
  };
}

/// Evento del webhook; solo lo necesario para saber a quién recalcular.
export const WebhookBody = z.object({
  event: z
    .object({
      id: z.string().min(1),
      type: z.string().min(1),
      app_user_id: z.string().nullish(),
      original_app_user_id: z.string().nullish(),
      aliases: z.array(z.string()).nullish(),
      transferred_from: z.array(z.string()).nullish(),
      transferred_to: z.array(z.string()).nullish(),
    })
    .loose(),
});

/// Ids de organización que menciona el evento (un comprador anónimo pudo
/// enlazarse después; una transferencia toca a dos).
export function organizationIdsOf(event: z.infer<typeof WebhookBody>['event']): string[] {
  const ids = [
    event.app_user_id,
    event.original_app_user_id,
    ...(event.aliases ?? []),
    ...(event.transferred_from ?? []),
    ...(event.transferred_to ?? []),
  ];
  return [
    ...new Set(ids.filter((id): id is string => !!id && z.uuid().safeParse(id).success)),
  ];
}
