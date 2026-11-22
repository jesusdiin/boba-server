import { z } from 'zod';

/// Planes de pago y sus límites (ver boba_pos/docs/COMERCIALIZACION.md). El
/// plan Free no existe aquí: es la app sin emparejar, sin servidor.
///
/// Regla de oro: el plan nunca bloquea el cobro. Los límites se aplican al
/// sumar miembros (equipos, sucursales) y un plan vencido pausa la nube
/// (402), pero nunca se rechaza un evento ya ocurrido en el mostrador.

export type PlanName = 'pro' | 'max';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

/// `active`: al corriente. `grace`: venció hace menos de [GRACE_DAYS] (todo
/// sigue funcionando, la app avisa). `lapsed`: la nube se pausa.
export type PlanState = 'active' | 'grace' | 'lapsed';

export interface PlanLimits {
  /// Sucursales de la organización.
  branches: number;
  /// Equipos no revocados de la organización (caja y kiosco).
  devices: number;
}

export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  pro: { branches: 1, devices: 3 },
  max: { branches: 3, devices: 10 },
};

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/// Ajustes por organización (tratos especiales); solo enteros positivos.
export const LimitOverrides = z
  .object({
    branches: z.number().int().min(1).max(1000),
    devices: z.number().int().min(1).max(1000),
  })
  .partial()
  .strict();

export interface OrgPlanFields {
  plan: PlanName;
  subscriptionStatus: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  limitOverrides: unknown;
}

export interface Entitlements {
  plan: PlanName;
  status: SubscriptionStatus;
  state: PlanState;
  /// Fin del periodo pagado (o de la prueba); `null` = sin vencimiento.
  periodEnd: Date | null;
  /// Hasta cuándo dura la gracia; `null` = sin vencimiento.
  graceUntil: Date | null;
  limits: PlanLimits;
}

export const trialEnd = (now: Date): Date =>
  new Date(now.getTime() + TRIAL_DAYS * DAY_MS);

/// Plan efectivo de una organización en [now].
export function entitlementsOf(org: OrgPlanFields, now: Date): Entitlements {
  const periodEnd = org.currentPeriodEnd;
  const graceUntil = periodEnd
    ? new Date(periodEnd.getTime() + GRACE_DAYS * DAY_MS)
    : null;
  const overrides = LimitOverrides.safeParse(org.limitOverrides ?? {});
  const limits = {
    ...PLAN_LIMITS[org.plan],
    ...(overrides.success ? overrides.data : {}),
  };
  return {
    plan: org.plan,
    status: org.subscriptionStatus,
    state: stateOf(org.subscriptionStatus, periodEnd, graceUntil, now),
    periodEnd,
    graceUntil,
    limits,
  };
}

function stateOf(
  status: SubscriptionStatus,
  periodEnd: Date | null,
  graceUntil: Date | null,
  now: Date,
): PlanState {
  // Cancelado: lo pagado se respeta hasta el fin del periodo, sin gracia.
  if (status === 'canceled') return periodEnd && now < periodEnd ? 'active' : 'lapsed';
  if (!periodEnd || !graceUntil) return 'active';
  if (now < periodEnd) return status === 'past_due' ? 'grace' : 'active';
  return now < graceUntil ? 'grace' : 'lapsed';
}

/// Forma pública (pull, errores 402, admin). La app la guarda tal cual;
/// `organizationId` es su usuario en la tienda (RevenueCat).
export function planJson(e: Entitlements, organizationId?: string) {
  return {
    ...(organizationId ? { organizationId } : {}),
    plan: e.plan,
    status: e.status,
    state: e.state,
    periodEnd: e.periodEnd?.toISOString() ?? null,
    graceUntil: e.graceUntil?.toISOString() ?? null,
    limits: e.limits,
  };
}
