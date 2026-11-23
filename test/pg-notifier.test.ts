import { afterEach, describe, expect, it } from 'vitest';

import type {
  RealtimeConnection,
  RealtimeMessage,
} from '../src/realtime/branchNotifier.js';
import { PgBranchNotifier } from '../src/realtime/pgNotifier.js';
import { setupTestApp } from './helpers.js';

const t = setupTestApp();
const url = process.env.DATABASE_URL ?? '';
const open: PgBranchNotifier[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((n) => n.close()));
});

async function instance() {
  const n = new PgBranchNotifier(t.db, url);
  await n.start();
  open.push(n);
  return n;
}

function socket(branchId: string, deviceId = 'd1') {
  const messages: RealtimeMessage[] = [];
  const closed: number[] = [];
  const connection: RealtimeConnection = {
    deviceId,
    branchId,
    send: (m) => messages.push(m),
    close: (code) => closed.push(code),
  };
  return { connection, messages, closed };
}

const until = async (cond: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('sin aviso');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('PgBranchNotifier (varias instancias)', () => {
  it('un aviso en A llega a los sockets de B; los de A, al instante y una vez', async () => {
    const a = await instance();
    const b = await instance();
    const onA = socket('b1');
    const onB = socket('b1');
    const other = socket('b2');
    a.add(onA.connection);
    b.add(onB.connection);
    b.add(other.connection);

    a.notify('b1', 42n);
    expect(onA.messages).toEqual([{ type: 'events', upTo: '42' }]);
    await until(() => onB.messages.length > 0);
    expect(onB.messages).toEqual([{ type: 'events', upTo: '42' }]);

    a.notifyPlan('b1');
    await until(() => onB.messages.length > 1);
    expect(onB.messages[1]).toEqual({ type: 'plan' });

    await new Promise((r) => setTimeout(r, 150));
    // A no recibe de vuelta lo que publicó; otra sucursal no recibe nada.
    expect(onA.messages).toHaveLength(2);
    expect(other.messages).toEqual([]);
  });

  it('desconectar un equipo cierra su socket en cualquier instancia', async () => {
    const a = await instance();
    const b = await instance();
    const s = socket('b1', 'equipo-7');
    b.add(s.connection);
    a.disconnectDevice('equipo-7', 4409, 'moved');
    await until(() => s.closed.length > 0);
    expect(s.closed).toEqual([4409]);
  });
});
