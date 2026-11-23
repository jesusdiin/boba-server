import { pino } from 'pino';

import { createApp } from './app.js';
import { revenueCatFetcher } from './billing/revenuecat.js';
import { createDb } from './db.js';
import { loadEnv } from './env.js';
import { purgeUnusedMedia } from './media/cleanup.js';
import { ConsoleMailer, SmtpMailer } from './mail/mailer.js';
import { InProcessBranchNotifier } from './realtime/branchNotifier.js';
import { PgBranchNotifier } from './realtime/pgNotifier.js';
import { attachRealtime } from './realtime/wsServer.js';
import { DbThrottle, purgeExpiredThrottles } from './throttle.js';

const env = loadEnv();
const logger = pino({ level: env.LOG_LEVEL });
const db = createDb(env.DATABASE_URL);
// Avisos en tiempo real: con Postgres llegan a todas las instancias.
const pgNotifier =
  env.REALTIME_BACKEND === 'postgres'
    ? new PgBranchNotifier(db, env.DATABASE_URL, logger)
    : null;
const notifier = pgNotifier ?? new InProcessBranchNotifier();
await pgNotifier?.start();

// Frenos compartidos entre instancias (tabla rate_limits).
const MIN = 60 * 1000;
const throttles = {
  signup: new DbThrottle(db, 'signup', 5, 60 * MIN),
  pair: new DbThrottle(db, 'pair', 10, 15 * MIN),
  ops: new DbThrottle(db, 'ops-login', 10, 15 * MIN),
  account: new DbThrottle(db, 'account', 3, 15 * MIN),
  coupon: new DbThrottle(db, 'coupon', 10, 15 * MIN),
};
const purge = setInterval(() => {
  purgeExpiredThrottles(db).catch((err: unknown) =>
    logger.warn({ err }, 'purga de frenos'),
  );
}, 60 * MIN);
purge.unref();

// Fotos que ya nadie usa (se cambió, se quitó o nunca se guardó el producto).
const DAY = 24 * 60 * MIN;
const purgeMedia = () =>
  purgeUnusedMedia(db)
    .then((n) => n > 0 && logger.info({ deleted: n }, 'fotos sin usar borradas'))
    .catch((err: unknown) => logger.warn({ err }, 'limpieza de fotos'));
const firstMediaPurge = setTimeout(() => void purgeMedia(), 10 * MIN);
firstMediaPurge.unref();
const mediaPurge = setInterval(() => void purgeMedia(), DAY);
mediaPurge.unref();
if (!env.SMTP_HOST && process.env.NODE_ENV === 'production') {
  logger.warn('Sin SMTP_HOST: los códigos de la cuenta del Dueño solo van al log');
}
const mailer = env.SMTP_HOST
  ? new SmtpMailer({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.MAIL_FROM,
    })
  : new ConsoleMailer(logger);
const app = createApp({
  db,
  adminApiKey: env.ADMIN_API_KEY,
  logger,
  notifier,
  signupEnabled: env.SIGNUP_ENABLED,
  requireEventActor: env.REQUIRE_EVENT_ACTOR,
  mailer,
  trustProxy: env.TRUST_PROXY,
  pairingThrottle: throttles.pair,
  signupThrottle: throttles.signup,
  accountThrottle: throttles.account,
  couponThrottle: throttles.coupon,
  ops: {
    throttle: throttles.ops,
    origins: env.ADMIN_PANEL_ORIGIN,
    prices: { pro: env.PLAN_PRICE_PRO_CENTS, max: env.PLAN_PRICE_MAX_CENTS },
  },
  billing: {
    fetchSubscriber: env.REVENUECAT_SECRET_KEY
      ? revenueCatFetcher(env.REVENUECAT_SECRET_KEY)
      : undefined,
    webhookSecret: env.REVENUECAT_WEBHOOK_SECRET,
  },
});

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'boba-server escuchando');
});
const realtime = attachRealtime(server, { db, notifier, logger });

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'cerrando');
  realtime.close();
  clearInterval(purge);
  clearInterval(mediaPurge);
  clearTimeout(firstMediaPurge);
  await pgNotifier?.close();
  server.close();
  await db.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
