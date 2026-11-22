import { pino } from 'pino';

import { createApp } from './app.js';
import { revenueCatFetcher } from './billing/revenuecat.js';
import { createDb } from './db.js';
import { loadEnv } from './env.js';
import { ConsoleMailer, SmtpMailer } from './mail/mailer.js';
import { InProcessBranchNotifier } from './realtime/branchNotifier.js';
import { attachRealtime } from './realtime/wsServer.js';

const env = loadEnv();
const logger = pino({ level: env.LOG_LEVEL });
const db = createDb(env.DATABASE_URL);
const notifier = new InProcessBranchNotifier();
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
  ops: {
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
  server.close();
  await db.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
