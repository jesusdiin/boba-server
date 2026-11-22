import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  ADMIN_API_KEY: z.string().min(8, 'ADMIN_API_KEY debe tener al menos 8 caracteres'),
  /// `false` cierra `POST /v1/signup` (alta de negocios desde la app).
  SIGNUP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /// `true` rechaza (`actor_required`) los cambios de usuarios, catálogo e
  /// insumos que no dicen quién los hizo, salvo al arrancar una sucursal.
  /// Encender cuando todos los equipos tengan la app que manda el actor.
  REQUIRE_EVENT_ACTOR: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /// Cobro en la app: llave secreta de la API de RevenueCat y el valor del
  /// header `Authorization` de su webhook. Sin ellas, `/v1/billing/*` → 503.
  REVENUECAT_SECRET_KEY: z.string().min(1).optional(),
  REVENUECAT_WEBHOOK_SECRET: z.string().min(16).optional(),
  /// Orígenes del panel del operador (boba_admin), separados por comas;
  /// CORS con cookies solo para ellos en `/v1/ops`.
  ADMIN_PANEL_ORIGIN: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  /// Precio mensual por plan (centavos MXN) para el MRR estimado del panel.
  PLAN_PRICE_PRO_CENTS: z.coerce.number().int().min(0).default(34900),
  PLAN_PRICE_MAX_CENTS: z.coerce.number().int().min(0).optional(),
  PORT: z.coerce.number().int().min(0).default(4000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return Env.parse(source);
}
