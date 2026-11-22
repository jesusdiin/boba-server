import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { Request, RequestHandler, Response } from 'express';

import type { Db } from '../db.js';
import { HttpError, unauthorized } from '../errors.js';
import { sha256 } from '../tokens.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export const SESSION_COOKIE = 'boba_ops';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/// Operador de la sesión (panel `boba_admin`).
export interface OperatorContext {
  id: string;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      operator?: OperatorContext;
    }
  }
}

// --- Contraseñas (scrypt) ----------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/// Contraseña inicial legible (la da `operator:create`; se cambia en el panel).
export const newOperatorPassword = (): string => randomBytes(12).toString('base64url');

// --- Sesión en cookie ---------------------------------------------------------

/// Lee una cookie sin dependencias (`a=1; b=2`).
export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.header('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/// `Secure` salvo en localhost (desarrollo por http).
const isLocal = (req: Request) => /^(localhost|127\.0\.0\.1)$/.test(req.hostname);

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !isLocal(req),
    path: '/v1/ops',
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !isLocal(req),
    path: '/v1/ops',
  });
}

export async function createSession(db: Db, operatorId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.operatorSession.create({
    data: {
      tokenHash: sha256(token),
      operatorId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return token;
}

/// Exige una sesión vigente de un operador activo.
export const requireOperator =
  (db: Db): RequestHandler =>
  async (req, _res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw unauthorized('Inicia sesión');
    const session = await db.operatorSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { operator: true },
    });
    if (!session || session.expiresAt <= new Date() || session.operator.disabledAt) {
      throw unauthorized('Tu sesión venció; vuelve a entrar');
    }
    req.operator = {
      id: session.operator.id,
      email: session.operator.email,
      name: session.operator.name,
    };
    next();
  };

// --- CORS y CSRF ----------------------------------------------------------------

/// CORS con cookies solo para los orígenes del panel. Las escrituras exigen
/// JSON y un `Origin` permitido (o ninguno: herramientas como curl), lo que
/// con `SameSite=Lax` cierra el CSRF.
export const opsCors =
  (allowed: readonly string[]): RequestHandler =>
  (req, res, next) => {
    const origin = req.header('origin');
    const ok = origin !== undefined && allowed.includes(origin);
    if (ok) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!ok) throw new HttpError(403, 'origin_forbidden', 'Origen no permitido');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (origin !== undefined && !ok) {
        throw new HttpError(403, 'origin_forbidden', 'Origen no permitido');
      }
      if (!req.is('application/json')) {
        throw new HttpError(415, 'json_required', 'Se espera application/json');
      }
    }
    next();
  };
