import type { Organization } from '../../generated/prisma/client.js';
import type { Db } from '../db.js';
import { entitlementsOf, planJson, type Entitlements } from '../plans.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/// Segmento comercial de un negocio para el panel.
/// - `paid`: pagando y al corriente (o en gracia por un pago pendiente).
/// - `trial`: en prueba. `courtesy`: activo sin vencimiento (trato manual).
/// - `canceled`: canceló pero aún tiene periodo pagado.
/// - `grace` / `lapsed`: venció (con o sin gracia).
export type Segment = 'paid' | 'trial' | 'courtesy' | 'canceled' | 'grace' | 'lapsed';

export function segmentOf(e: Entitlements): Segment {
  if (e.state === 'lapsed') return 'lapsed';
  if (e.status === 'trialing') return e.state === 'grace' ? 'grace' : 'trial';
  if (e.status === 'canceled') return 'canceled';
  if (e.state === 'grace') return 'grace';
  if (e.status === 'active' && e.periodEnd === null) return 'courtesy';
  return 'paid';
}

export interface Prices {
  pro: number;
  /// `undefined`: sin precio configurado (no entra al MRR).
  max?: number;
}

/// Totales por organización que no están en la fila: equipos, sucursales,
/// última conexión y ventas de los últimos 30 días.
interface OrgUsage {
  branches: number;
  devices: number;
  lastSeenAt: Date | null;
  sales30dCents: number;
  tickets30d: number;
}

async function usageByOrg(db: Db, now: Date): Promise<Map<string, OrgUsage>> {
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const [branches, devices, sales] = await Promise.all([
    db.$queryRaw<{ organization_id: string; n: bigint }[]>`
      SELECT organization_id, COUNT(*) AS n FROM branches GROUP BY organization_id`,
    db.$queryRaw<{ organization_id: string; n: bigint; last_seen: Date | null }[]>`
      SELECT organization_id,
             COUNT(*) FILTER (WHERE revoked_at IS NULL) AS n,
             MAX(last_seen_at) AS last_seen
        FROM devices GROUP BY organization_id`,
    db.$queryRaw<{ organization_id: string; total: bigint | null; n: bigint }[]>`
      SELECT b.organization_id, SUM(s.total_cents) AS total, COUNT(*) AS n
        FROM branch_sales s JOIN branches b ON b.id = s.branch_id
       WHERE s.created_at_utc >= ${since}
       GROUP BY b.organization_id`,
  ]);
  const usage = new Map<string, OrgUsage>();
  const get = (id: string) => {
    let u = usage.get(id);
    if (!u) {
      u = { branches: 0, devices: 0, lastSeenAt: null, sales30dCents: 0, tickets30d: 0 };
      usage.set(id, u);
    }
    return u;
  };
  for (const r of branches) get(r.organization_id).branches = Number(r.n);
  for (const r of devices) {
    const u = get(r.organization_id);
    u.devices = Number(r.n);
    u.lastSeenAt = r.last_seen;
  }
  for (const r of sales) {
    const u = get(r.organization_id);
    u.sales30dCents = Number(r.total ?? 0);
    u.tickets30d = Number(r.n);
  }
  return usage;
}

/// Fila de la lista de negocios.
export function orgSummary(org: Organization, usage: OrgUsage | undefined, now: Date) {
  const e = entitlementsOf(org, now);
  return {
    id: org.id,
    name: org.name,
    createdAt: org.createdAt,
    billingSource: org.billingSource,
    segment: segmentOf(e),
    plan: planJson(e),
    usage: {
      branches: usage?.branches ?? 0,
      devices: usage?.devices ?? 0,
    },
    lastSeenAt: usage?.lastSeenAt ?? null,
    sales30dCents: usage?.sales30dCents ?? 0,
    tickets30d: usage?.tickets30d ?? 0,
  };
}
export type OrgSummary = ReturnType<typeof orgSummary>;

export async function listOrganizations(db: Db, now: Date): Promise<OrgSummary[]> {
  const [orgs, usage] = await Promise.all([
    db.organization.findMany({ orderBy: { createdAt: 'desc' } }),
    usageByOrg(db, now),
  ]);
  return orgs.map((o) => orgSummary(o, usage.get(o.id), now));
}

/// Resumen del sistema para la portada del panel.
export async function systemStats(db: Db, prices: Prices, now: Date) {
  const orgs = await listOrganizations(db, now);
  const bySegment: Record<Segment, number> = {
    paid: 0,
    trial: 0,
    courtesy: 0,
    canceled: 0,
    grace: 0,
    lapsed: 0,
  };
  let mrrCents = 0;
  let mrrMissingPrice = 0;
  for (const o of orgs) {
    bySegment[o.segment]++;
    // MRR: lo que se cobra cada mes (de pago, o en gracia por pago pendiente).
    if (o.segment === 'paid' || (o.segment === 'grace' && o.plan.status === 'past_due')) {
      const price = o.plan.plan === 'pro' ? prices.pro : prices.max;
      if (price === undefined) mrrMissingPrice++;
      else mrrCents += price;
    }
  }

  const week = 7 * DAY_MS;
  const signups = Array.from({ length: 12 }, (_, i) => {
    const end = new Date(now.getTime() - (11 - i) * week);
    const start = new Date(end.getTime() - week);
    return {
      weekStart: start.toISOString(),
      count: orgs.filter((o) => o.createdAt > start && o.createdAt <= end).length,
    };
  });

  const [active24h, active7d] = await Promise.all([
    db.device.count({
      where: { revokedAt: null, lastSeenAt: { gte: new Date(now.getTime() - DAY_MS) } },
    }),
    db.device.count({
      where: { revokedAt: null, lastSeenAt: { gte: new Date(now.getTime() - week) } },
    }),
  ]);

  const soon = new Date(now.getTime() + week);
  const trialsEnding = orgs
    .filter(
      (o) =>
        o.segment === 'trial' &&
        o.plan.periodEnd !== null &&
        new Date(o.plan.periodEnd) <= soon,
    )
    .sort((a, b) => (a.plan.periodEnd ?? '').localeCompare(b.plan.periodEnd ?? ''));
  const inactive = orgs.filter(
    (o) =>
      o.segment !== 'lapsed' &&
      (o.lastSeenAt === null || o.lastSeenAt.getTime() < now.getTime() - week),
  );

  return {
    organizations: orgs.length,
    bySegment,
    mrrCents,
    mrrMissingPrice,
    devices: { active24h, active7d },
    sales30dCents: orgs.reduce((sum, o) => sum + o.sales30dCents, 0),
    signups,
    trialsEnding,
    inactive,
  };
}

/// Detalle de un negocio para soporte (sin datos personales: usuarios solo
/// como conteo por rol; ventas solo totales).
export async function organizationDetail(db: Db, organizationId: string, now: Date) {
  const org = await db.organization.findUnique({ where: { id: organizationId } });
  if (!org) return null;
  const usage = (await usageByOrg(db, now)).get(org.id);
  const since = new Date(now.getTime() - 30 * DAY_MS);

  const [branches, users, sales, conflicts, billingEvents, audit] = await Promise.all([
    db.branch.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'asc' },
      include: {
        devices: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            mode: true,
            folioPrefix: true,
            lastSeenAt: true,
            revokedAt: true,
            createdAt: true,
          },
        },
      },
    }),
    db.$queryRaw<{ branch_id: string; role: string | null; n: bigint }[]>`
      SELECT u.branch_id, u.role, COUNT(*) AS n
        FROM branch_users u JOIN branches b ON b.id = u.branch_id
       WHERE b.organization_id = ${org.id}::uuid AND u.is_active IS NOT FALSE
       GROUP BY u.branch_id, u.role`,
    db.$queryRaw<{ branch_id: string; day: string; total: bigint | null; n: bigint }[]>`
      SELECT s.branch_id, s.business_date AS day, SUM(s.total_cents) AS total, COUNT(*) AS n
        FROM branch_sales s JOIN branches b ON b.id = s.branch_id
       WHERE b.organization_id = ${org.id}::uuid AND s.created_at_utc >= ${since}
       GROUP BY s.branch_id, s.business_date
       ORDER BY s.business_date`,
    db.syncConflict.findMany({
      where: { branch: { organizationId: org.id } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    db.billingEvent.findMany({
      where: { organizationId: org.id },
      orderBy: { receivedAt: 'desc' },
      take: 20,
      select: { id: true, type: true, receivedAt: true },
    }),
    db.operatorAudit.findMany({
      where: { organizationId: org.id },
      orderBy: { at: 'desc' },
      take: 50,
      include: { operator: { select: { name: true, email: true } } },
    }),
  ]);

  return {
    ...orgSummary(org, usage, now),
    limitOverrides: org.limitOverrides,
    branches: branches.map((b) => ({
      id: b.id,
      name: b.name,
      timezoneId: b.timezoneId,
      createdAt: b.createdAt,
      devices: b.devices,
      usersByRole: Object.fromEntries(
        users.filter((u) => u.branch_id === b.id).map((u) => [u.role ?? '?', Number(u.n)]),
      ),
    })),
    salesByDay: sales.map((s) => ({
      branchId: s.branch_id,
      day: s.day,
      totalCents: Number(s.total ?? 0),
      tickets: Number(s.n),
    })),
    conflicts: conflicts.map((c) => ({
      id: c.id,
      branchId: c.branchId,
      kind: c.kind,
      eventId: c.eventId,
      createdAt: c.createdAt,
    })),
    billingEvents,
    audit: audit.map(auditJson),
  };
}

export function auditJson(a: {
  id: string;
  action: string;
  organizationId: string | null;
  details: unknown;
  at: Date;
  operator: { name: string; email: string };
}) {
  return {
    id: a.id,
    action: a.action,
    organizationId: a.organizationId,
    details: a.details,
    at: a.at,
    operator: a.operator.name,
  };
}
