import type { Db } from '../db.js';
import type { Tx } from '../sync/rules.js';
import type { PushSender } from './sender.js';

/// Tipos de aviso. Las claves viajan desde la app (`muted_topics`): no
/// renombrar.
export const PUSH_TOPICS = ['orders', 'shifts', 'stock', 'news'] as const;
export type PushTopic = (typeof PUSH_TOPICS)[number];

export interface BranchNotice {
  topic: PushTopic;
  title: string;
  body: string;
}

/// Un equipo que estuvo sin red sube su atraso de golpe: lo que pasó hace
/// más de esto ya no se avisa.
export const FRESH_MS = 30 * 60 * 1000;

/// Como mucho, avisos por cada push de un equipo (el resto se omite).
export const MAX_NOTICES_PER_PUSH = 5;

type Payload = Record<string, unknown>;

interface BranchInfo {
  name: string;
  currencyCode: string;
}

interface AcceptedEvent {
  type: string;
  createdAtUtc: string;
  payload: Payload;
}

const CHANNELS: Readonly<Record<string, string>> = {
  counter: 'Mostrador',
  instagram: 'Instagram',
  messenger: 'Messenger',
  whatsapp: 'WhatsApp',
  kiosk: 'Kiosco',
};

const UNITS: Readonly<Record<string, string>> = { kg: 'kg', liter: 'L', piece: 'pz' };

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
const obj = (v: unknown): Payload | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Payload) : null;
const rows = (v: unknown): Payload[] =>
  Array.isArray(v) ? v.flatMap((r) => (obj(r) ? [r as Payload] : [])) : [];

/// `$1,850` o `$1,850.50`.
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/// Milésimas de la unidad del insumo → `1.2 L`, `3 pz`.
export function formatQuantity(milli: number, unit: string | null): string {
  const value = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 }).format(
    Math.max(0, milli) / 1000,
  );
  const label = unit ? (UNITS[unit] ?? unit) : null;
  return label ? `${value} ${label}` : value;
}

function itemCount(itemsJson: unknown): number {
  if (typeof itemsJson !== 'string') return 0;
  try {
    const items: unknown = JSON.parse(itemsJson);
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return 0;
  }
}

function orderNotice(row: Payload): BranchNotice {
  const folio = str(row.folio);
  const items = itemCount(row.itemsJson);
  const parts = [
    CHANNELS[str(row.channel) ?? ''] ?? null,
    str(row.customerName),
    items > 0 ? `${items} ${items === 1 ? 'producto' : 'productos'}` : null,
  ].filter((p): p is string => p != null);
  return {
    topic: 'orders',
    title: folio ? `Pedido nuevo · ${folio}` : 'Pedido nuevo',
    body: parts.join(' · ') || 'Revisa los pedidos',
  };
}

function shiftNotice(type: string, row: Payload, branch: BranchInfo): BranchNotice {
  const money = (cents: number) => formatMoney(cents, branch.currencyCode);
  if (type === 'shift.opened') {
    const starting = int(row.startingCashCents);
    return {
      topic: 'shifts',
      title: `Caja abierta · ${branch.name}`,
      body: starting == null ? 'Turno iniciado' : `Fondo ${money(starting)}`,
    };
  }
  const counted = int(row.closingCountedCashCents);
  const expected = int(row.closingExpectedCashCents);
  const parts: string[] = [];
  if (counted != null) parts.push(`Contado ${money(counted)}`);
  if (expected != null) parts.push(`esperado ${money(expected)}`);
  if (counted != null && expected != null) {
    const diff = counted - expected;
    parts.push(
      diff === 0
        ? 'cuadra'
        : diff < 0
          ? `faltan ${money(-diff)}`
          : `sobran ${money(diff)}`,
    );
  }
  return {
    topic: 'shifts',
    title: `Caja cerrada · ${branch.name}`,
    body: parts.join(' · ') || 'Turno cerrado',
  };
}

/// Insumos que este evento dejó por debajo de su mínimo (solo al cruzarlo,
/// no en cada venta). Corre ya proyectado el evento: la suma de movimientos
/// es la existencia después.
async function stockNotices(
  tx: Tx,
  branchId: string,
  movements: Payload[],
): Promise<BranchNotice[]> {
  const deltas = new Map<string, number>();
  for (const m of movements) {
    const supplyId = str(m.supplyId);
    const delta = int(m.quantityDeltaMilli);
    if (supplyId && delta != null && delta < 0) {
      deltas.set(supplyId, (deltas.get(supplyId) ?? 0) + delta);
    }
  }
  const notices: BranchNotice[] = [];
  for (const [supplyId, delta] of deltas) {
    const supply = await tx.branchSupply.findUnique({
      where: { branchId_id: { branchId, id: supplyId } },
    });
    const min = supply?.minQuantityMilli;
    if (!supply || min == null || min <= 0 || supply.isActive === false) continue;
    const total = await tx.branchSupplyMovement.aggregate({
      where: { branchId, supplyId },
      _sum: { quantityDeltaMilli: true },
    });
    const after = total._sum.quantityDeltaMilli ?? 0;
    const before = after - delta;
    if (before >= min && after < min) {
      notices.push({
        topic: 'stock',
        title: `Insumo bajo: ${supply.name ?? 'sin nombre'}`,
        body: `Quedan ${formatQuantity(after, supply.unit)} (mínimo ${formatQuantity(min, supply.unit)})`,
      });
    }
  }
  return notices;
}

/// Avisos que dispara un evento recién aceptado. Se llama dentro de la
/// transacción del push, después de `insertEvent` (ya proyectado).
export async function noticesFor(
  tx: Tx,
  branchId: string,
  branch: BranchInfo,
  event: AcceptedEvent,
  now: Date = new Date(),
): Promise<BranchNotice[]> {
  const createdAt = Date.parse(event.createdAtUtc);
  if (Number.isNaN(createdAt) || now.getTime() - createdAt > FRESH_MS) return [];
  const { payload } = event;
  switch (event.type) {
    case 'incoming_order.created':
      return [orderNotice(payload)];
    case 'shift.opened':
    case 'shift.closed':
      return [shiftNotice(event.type, payload, branch)];
    case 'sale.created':
      return stockNotices(tx, branchId, rows(payload.supplyMovements));
    case 'supply_movement.created':
      return stockNotices(tx, branchId, [payload]);
    default:
      return [];
  }
}

/// Manda [notices] a los equipos de la sucursal (no revocados, no kiosco),
/// menos el que originó los eventos, según los tipos que cada instalación
/// tenga encendidos. Borra las instalaciones que FCM ya no reconoce.
export async function sendBranchNotices(
  db: Db,
  push: PushSender,
  target: { organizationId: string; branchId: string; originDeviceId: string },
  notices: BranchNotice[],
): Promise<void> {
  if (notices.length === 0) return;
  const devices = await db.device.findMany({
    where: {
      branchId: target.branchId,
      organizationId: target.organizationId,
      revokedAt: null,
      mode: 'staff',
      id: { not: target.originDeviceId },
    },
    select: { id: true },
  });
  if (devices.length === 0) return;
  const installs = await db.pushToken.findMany({
    where: {
      organizationId: target.organizationId,
      deviceId: { in: devices.map((d) => d.id) },
    },
    select: { token: true, mutedTopics: true },
  });
  const invalid = new Set<string>();
  for (const notice of notices.slice(0, MAX_NOTICES_PER_PUSH)) {
    const tokens = installs
      .filter((i) => !i.mutedTopics.includes(notice.topic) && !invalid.has(i.token))
      .map((i) => i.token);
    if (tokens.length === 0) continue;
    const result = await push.send(tokens, { title: notice.title, body: notice.body });
    result.invalidTokens.forEach((t) => invalid.add(t));
  }
  if (invalid.size > 0) {
    await db.pushToken.deleteMany({ where: { token: { in: [...invalid] } } });
  }
}
