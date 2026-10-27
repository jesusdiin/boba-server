import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  ADMIN_API_KEY: z.string().min(8, 'ADMIN_API_KEY debe tener al menos 8 caracteres'),
  /// `false` cierra `POST /v1/signup` (alta de negocios desde la app).
  SIGNUP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  PORT: z.coerce.number().int().min(0).default(4000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return Env.parse(source);
}
