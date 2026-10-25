import { execSync } from 'node:child_process';

/// Aplica las migraciones pendientes a boba_test (no destructivo: cada test
/// vacía sus tablas con TRUNCATE en `setupTestApp`). Nunca apunta a boba_dev:
/// falla si la URL no es la de pruebas.
export default function setup(): void {
  process.loadEnvFile('.env.test');
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('boba_test')) {
    throw new Error(`Los tests solo corren contra boba_test (DATABASE_URL=${url})`);
  }
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
