import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/// Token de dispositivo: 32 bytes aleatorios. Solo se guarda su hash.
export const newDeviceToken = (): string => randomBytes(32).toString('base64url');

/// Sin 0/O/1/I para que se pueda dictar o teclear sin confusión.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;

export function newPairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/// Normaliza lo que teclea el usuario ("abcd-2345" → "ABCD2345").
export const normalizePairingCode = (code: string): string =>
  code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
