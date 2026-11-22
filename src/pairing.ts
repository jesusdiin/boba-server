import type { Branch, Device } from '../generated/prisma/client.js';

import { subscriptionInactive } from './auth/deviceAuth.js';
import type { Db } from './db.js';
import { HttpError, notFound } from './errors.js';
import { entitlementsOf } from './plans.js';
import type { Tx } from './sync/rules.js';
import { newDeviceToken, newPairingCode, normalizePairingCode, sha256 } from './tokens.js';

export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

/// Código de un solo uso para sumar un dispositivo a la sucursal. El código
/// en claro solo sale de aquí (se guarda su hash).
export async function createPairingCode(
  db: Db | Tx,
  branchId: string,
): Promise<{ code: string; expiresAt: Date }> {
  const code = newPairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  await db.devicePairingCode.create({
    data: { branchId, codeHash: sha256(normalizePairingCode(code)), expiresAt },
  });
  return { code, expiresAt };
}

/// Alta de un dispositivo con su token; el token en claro solo vive en la
/// respuesta que lo entrega.
export async function createDevice(
  tx: Tx,
  data: {
    organizationId: string;
    branchId: string;
    name: string;
    mode: 'staff' | 'kiosk';
  },
): Promise<{ device: Device; token: string }> {
  const token = newDeviceToken();
  // Bloquea la organización (dos altas simultáneas no rebasan el límite del
  // plan) y la sucursal (no toman la misma letra de folio).
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${data.organizationId}::uuid FOR UPDATE`;
  await ensureCanAddDevice(tx, data.organizationId);
  await tx.$queryRaw`SELECT id FROM branches WHERE id = ${data.branchId}::uuid FOR UPDATE`;
  const count = await tx.device.count({ where: { branchId: data.branchId } });
  const device = await tx.device.create({
    data: { ...data, folioPrefix: folioPrefixFor(count), tokenHash: sha256(token) },
  });
  return { device, token };
}

/// Letra de folio del equipo número [index] (0 → A, 25 → Z, 26 → AA…).
/// Igual que la migración `device_folio_prefix`.
export function folioPrefixFor(index: number): string {
  const letter = (n: number) => String.fromCharCode(65 + n);
  return index < 26 ? letter(index) : letter(Math.floor(index / 26) - 1) + letter(index % 26);
}

/// Respuesta de `/v1/devices/pair` y `/v1/signup`.
export function pairResponse(
  device: Device,
  branch: Branch,
  token: string,
  organizationName: string,
) {
  return {
    deviceId: device.id,
    /// Nombre del negocio: la app lo muestra en lugar de la marca por defecto.
    organizationName,
    folioPrefix: device.folioPrefix,
    token,
    organizationId: device.organizationId,
    branch: {
      id: branch.id,
      name: branch.name,
      timezoneId: branch.timezoneId,
      currencyCode: branch.currencyCode,
    },
  };
}

/// Error de límite del plan (equipos o sucursales).
export function planLimit(
  what: 'devices' | 'branches',
  limit: number,
  used: number,
): HttpError {
  const message =
    what === 'devices'
      ? `Tu plan permite ${limit} equipo${limit === 1 ? '' : 's'}; desconecta uno o mejora tu plan`
      : `Tu plan permite ${limit} sucursal${limit === 1 ? '' : 'es'}; mejora tu plan para agregar más`;
  return new HttpError(403, 'plan_limit', message, { limit: what, max: limit, used });
}

/// Falla si la organización no puede sumar otro equipo: plan vencido (402) o
/// sin cupo (403 `plan_limit`). Los revocados no cuentan.
export async function ensureCanAddDevice(
  db: Db | Tx,
  organizationId: string,
): Promise<void> {
  const org = await db.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw notFound('Organización no encontrada');
  const entitlements = entitlementsOf(org, new Date());
  if (entitlements.state === 'lapsed')
    throw subscriptionInactive(entitlements, organizationId);
  const used = await db.device.count({ where: { organizationId, revokedAt: null } });
  if (used >= entitlements.limits.devices) {
    throw planLimit('devices', entitlements.limits.devices, used);
  }
}

/// Falla si la organización ya tiene todas las sucursales de su plan.
export async function ensureCanAddBranch(
  db: Db | Tx,
  organizationId: string,
): Promise<void> {
  const org = await db.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw notFound('Organización no encontrada');
  const { limits } = entitlementsOf(org, new Date());
  const used = await db.branch.count({ where: { organizationId } });
  if (used >= limits.branches) throw planLimit('branches', limits.branches, used);
}
