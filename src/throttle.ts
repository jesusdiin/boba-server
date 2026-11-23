import type { Db } from './db.js';
import { HttpError } from './errors.js';

/// Freno de intentos: N por llave (IP, correo, usuario, equipo) por ventana.
export interface Throttle {
  /// Lanza `429 too_many_attempts` si la llave ya llegó al límite.
  ensureAllowed(key: string): Promise<void>;
  /// Cuenta un intento (fallido, o cada uno donde se limitan todos).
  recordFailure(key: string): Promise<void>;
}

const tooMany = () =>
  new HttpError(429, 'too_many_attempts', 'Demasiados intentos; espera unos minutos');

/// En memoria: para pruebas o una sola instancia del servidor.
export class MemoryThrottle implements Throttle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  async ensureAllowed(key: string, now = Date.now()): Promise<void> {
    const entry = this.failures.get(key);
    if (entry && entry.resetAt > now && entry.count >= this.maxFailures) throw tooMany();
  }

  async recordFailure(key: string, now = Date.now()): Promise<void> {
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }
}

/// Compartido entre instancias del servidor (tabla `rate_limits`). [name]
/// separa los frenos: `signup`, `pair`, `ops-login`…
export class DbThrottle implements Throttle {
  constructor(
    private readonly db: Db,
    private readonly name: string,
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  private key(key: string) {
    return `${this.name}:${key}`;
  }

  async ensureAllowed(key: string): Promise<void> {
    const rows = await this.db.$queryRaw<{ count: number }[]>`
      SELECT count FROM rate_limits
       WHERE key = ${this.key(key)} AND reset_at > now()`;
    if ((rows[0]?.count ?? 0) >= this.maxFailures) throw tooMany();
  }

  async recordFailure(key: string): Promise<void> {
    const seconds = this.windowMs / 1000;
    // Atómico: dos instancias que cuentan a la vez no se pisan.
    await this.db.$executeRaw`
      INSERT INTO rate_limits (key, count, reset_at)
      VALUES (${this.key(key)}, 1, now() + make_interval(secs => ${seconds}))
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
        reset_at = CASE WHEN rate_limits.reset_at <= now()
          THEN now() + make_interval(secs => ${seconds}) ELSE rate_limits.reset_at END`;
  }
}

/// Borra los contadores vencidos hace más de un día.
export async function purgeExpiredThrottles(db: Db): Promise<number> {
  return db.$executeRaw`DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day'`;
}
