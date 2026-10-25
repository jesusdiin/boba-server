import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Todos los tests comparten boba_test: en serie para no pisarse.
    fileParallelism: false,
    env: loadTestEnv(),
  },
});

function loadTestEnv(): Record<string, string> {
  // Vitest no carga .env.test por sí solo; se lee aquí para los workers.
  process.loadEnvFile('.env.test');
  return {
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? '',
  };
}
