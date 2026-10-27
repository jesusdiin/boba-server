import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';

import { adminAuth } from './auth/adminAuth.js';
import { deviceAuth } from './auth/deviceAuth.js';
import type { Db } from './db.js';
import { errorHandler, notFound } from './errors.js';
import { noopNotifier, type BranchNotifier } from './realtime/branchNotifier.js';
import { adminRouter } from './routes/admin.js';
import { branchRouter } from './routes/branch.js';
import { devicesRouter, PairingThrottle } from './routes/devices.js';
import { signupRouter } from './routes/signup.js';
import { snapshotRouter } from './routes/snapshot.js';
import { syncRouter } from './routes/sync.js';

export interface AppDeps {
  db: Db;
  adminApiKey: string;
  logger: Logger;
  pairingThrottle?: PairingThrottle;
  /// Avisos de tiempo real tras cada push aceptado (sin él, no-op).
  notifier?: BranchNotifier;
  /// Registro de negocios desde la app (`POST /v1/signup`).
  signupEnabled?: boolean;
  signupThrottle?: PairingThrottle;
}

/// App Express sin `listen` (los tests la usan con supertest).
export function createApp({
  db,
  adminApiKey,
  logger,
  pairingThrottle,
  notifier = noopNotifier,
  signupEnabled = true,
  signupThrottle,
}: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '5mb' }));

  app.get('/healthz', async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  });

  app.use('/v1/admin', adminAuth(adminApiKey), adminRouter(db, notifier));
  app.use('/v1/devices', devicesRouter(db, pairingThrottle));
  app.use(
    '/v1/signup',
    signupRouter(db, { enabled: signupEnabled, throttle: signupThrottle }),
  );
  app.use('/v1/sync', deviceAuth(db), syncRouter(db, notifier));
  app.use('/v1/branch', deviceAuth(db), branchRouter(db, notifier));
  app.use('/v1/branches', deviceAuth(db), snapshotRouter(db));

  app.use(() => {
    throw notFound('Ruta no encontrada');
  });
  app.use(errorHandler);
  return app;
}
