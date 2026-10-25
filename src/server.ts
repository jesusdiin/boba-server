import { pino } from 'pino';

import { createApp } from './app.js';
import { createDb } from './db.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const logger = pino({ level: env.LOG_LEVEL });
const db = createDb(env.DATABASE_URL);
const app = createApp({ db, adminApiKey: env.ADMIN_API_KEY, logger });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'boba-server escuchando');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'cerrando');
  server.close();
  await db.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
