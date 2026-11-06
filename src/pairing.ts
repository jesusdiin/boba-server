import type { Branch, Device } from '../generated/prisma/client.js';

import type { Db } from './db.js';
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
  // Bloquea la sucursal: dos altas simultáneas no pueden tomar la misma letra.
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
export function pairResponse(device: Device, branch: Branch, token: string) {
  return {
    deviceId: device.id,
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
