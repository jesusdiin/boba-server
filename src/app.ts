import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';

import { adminAuth } from './auth/adminAuth.js';
import { deviceAuth, requireActivePlan } from './auth/deviceAuth.js';
import type { Db } from './db.js';
import { errorHandler, notFound } from './errors.js';
import { noopNotifier, type BranchNotifier } from './realtime/branchNotifier.js';
import { adminRouter } from './routes/admin.js';
import {
  billingDeviceRouter,
  billingWebhookRouter,
  type BillingConfig,
} from './routes/billing.js';
import { opsCors } from './auth/operatorAuth.js';
import type { Prices } from './ops/stats.js';
import { opsRouter } from './routes/ops.js';
import { orgRouter } from './routes/org.js';
import { branchRouter } from './routes/branch.js';
import { devicesRouter, PairingThrottle } from './routes/devices.js';
import { mediaRouter } from './routes/media.js';
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
  /// Cobro en la app (RevenueCat); sin él, `/v1/billing/*` responde 503.
  billing?: BillingConfig;
  /// Rechazar cambios de usuarios/catálogo sin actor (`REQUIRE_EVENT_ACTOR`).
  requireEventActor?: boolean;
  /// Panel del operador: orígenes con CORS y precios para el MRR.
  ops?: { origins?: string[]; prices?: Prices; throttle?: PairingThrottle };
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
  billing = {},
  requireEventActor = false,
  ops = {},
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
  // Panel del operador (boba_admin, otro origen): CORS con cookie de sesión.
  app.use(
    '/v1/ops',
    opsCors(ops.origins ?? []),
    opsRouter(db, notifier, {
      prices: ops.prices ?? { pro: 34900 },
      throttle: ops.throttle,
    }),
  );
  app.use('/v1/devices', devicesRouter(db, pairingThrottle));
  app.use(
    '/v1/signup',
    signupRouter(db, { enabled: signupEnabled, throttle: signupThrottle }),
  );
  // Plan vencido: la nube se pausa (402), pero `/v1/branch` sigue abierto
  // para poder revocar equipos y ajustarse al límite.
  app.use('/v1/sync', deviceAuth(db), requireActivePlan, syncRouter(db, notifier, { requireActor: requireEventActor }));
  app.use('/v1/branch', deviceAuth(db), branchRouter(db, notifier));
  app.use('/v1/org', deviceAuth(db), requireActivePlan, orgRouter(db, notifier));
  app.use('/v1/billing', billingWebhookRouter(db, billing));
  app.use('/v1/billing', deviceAuth(db), billingDeviceRouter(db, billing));
  app.use('/v1/branches', deviceAuth(db), requireActivePlan, snapshotRouter(db));
  app.use('/v1/media', deviceAuth(db), requireActivePlan, mediaRouter(db));

  app.use(() => {
    throw notFound('Ruta no encontrada');
  });
  app.use(errorHandler);
  return app;
}
