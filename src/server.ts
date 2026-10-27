import { pino } from 'pino';

import { createApp } from './app.js';
import { createDb } from './db.js';
import { loadEnv } from './env.js';
import { InProcessBranchNotifier } from './realtime/branchNotifier.js';
import { attachRealtime } from './realtime/wsServer.js';

const env = loadEnv();
const logger = pino({ level: env.LOG_LEVEL });
const db = createDb(env.DATABASE_URL);
const notifier = new InProcessBranchNotifier();
const app = createApp({
  db,
  adminApiKey: env.ADMIN_API_KEY,
  logger,
  notifier,
  signupEnabled: env.SIGNUP_ENABLED,
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
