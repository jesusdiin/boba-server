import { describe, expect, it } from 'vitest';

import { DbThrottle, MemoryThrottle, purgeExpiredThrottles } from '../src/throttle.js';
import { setupTestApp } from './helpers.js';

const t = setupTestApp();

const blocked = (p: Promise<void>) =>
  expect(p).rejects.toMatchObject({ status: 429, code: 'too_many_attempts' });

describe('DbThrottle (compartido entre instancias)', () => {
  it('dos instancias comparten la cuenta de la misma llave', async () => {
    const a = new DbThrottle(t.db, 'signup', 3, 60_000);
    const b = new DbThrottle(t.db, 'signup', 3, 60_000);
    await a.recordFailure('1.2.3.4');
    await b.recordFailure('1.2.3.4');
    await a.ensureAllowed('1.2.3.4');
    await b.recordFailure('1.2.3.4');
    await blocked(a.ensureAllowed('1.2.3.4'));
    // Otra IP u otro freno no se ven afectados.
    await a.ensureAllowed('5.6.7.8');
    await new DbThrottle(t.db, 'pair', 3, 60_000).ensureAllowed('1.2.3.4');
  });

  it('concurrentes: ningún intento se pierde', async () => {
    const th = new DbThrottle(t.db, 'coupon', 100, 60_000);
    await Promise.all(Array.from({ length: 20 }, () => th.recordFailure('d1')));
    const row = await t.db.rateLimit.findUniqueOrThrow({ where: { key: 'coupon:d1' } });
    expect(row.count).toBe(20);
  });

  it('la ventana vence y vuelve a empezar; la purga borra lo viejo', async () => {
    const th = new DbThrottle(t.db, 'pair', 1, 60_000);
    await th.recordFailure('ip');
    await blocked(th.ensureAllowed('ip'));
    // Con SQL (el `now()` de la base), como lo hace DbThrottle.
    await t.db
      .$executeRaw`UPDATE rate_limits SET reset_at = now() - interval '1 second' WHERE key = 'pair:ip'`;
    await th.ensureAllowed('ip');
    await th.recordFailure('ip');
    expect(
      (await t.db.rateLimit.findUniqueOrThrow({ where: { key: 'pair:ip' } })).count,
    ).toBe(1);

    await t.db
      .$executeRaw`INSERT INTO rate_limits (key, count, reset_at) VALUES ('pair:viejo', 3, now() - interval '2 days')`;
    expect(await purgeExpiredThrottles(t.db)).toBe(1);
    expect(await t.db.rateLimit.count()).toBe(1);
  });
});

describe('MemoryThrottle', () => {
  it('cuenta por llave y bloquea al llegar al límite', async () => {
    const th = new MemoryThrottle(2, 60_000);
    await th.recordFailure('x');
    await th.recordFailure('x');
    await blocked(th.ensureAllowed('x'));
    await th.ensureAllowed('y');
  });
});
