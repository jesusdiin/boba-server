import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// DATABASE_URL viene de .env (dev) o del entorno (tests usan boba_test).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
