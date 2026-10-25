import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { CLOSE_REVOKED } from '../src/realtime/branchNotifier.js';
import { setupTestApp, userUpdatedEvent } from './helpers.js';

const t = setupTestApp();

type Message = { type: string; upTo?: string; branchId?: string };

/// Cliente WS de prueba que junta los mensajes recibidos.
async function connect(url: string, token: string) {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  const messages: Message[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (data) => {
    messages.push(JSON.parse(String(data)) as Message);
    waiters.splice(0).forEach((w) => w());
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  /// Espera hasta tener `n` mensajes (o falla a los 2 s).
  const next = async (n: number) => {
    const deadline = Date.now() + 2000;
    while (messages.length < n) {
      if (Date.now() > deadline) throw new Error(`esperaba ${n} mensajes: ${JSON.stringify(messages)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return messages[n - 1]!;
  };
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  return { ws, messages, next, closed };
}

/// Da tiempo a que lleguen avisos que no deberían llegar.
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('WS /v1/ws', () => {
  it('rechaza el upgrade sin token válido (401)', async () => {
    const url = await t.listen();
    const status = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(url, { headers: { authorization: 'Bearer nope' } });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.once('open', () => resolve(undefined));
      ws.once('error', () => {});
    });
    expect(status).toBe(401);
  });

  it('saluda con el último serverSeq de la sucursal', async () => {
    const url = await t.listen();
    const a = await t.pairedDevice();
    const pushed = await t.push(a.token, [userUpdatedEvent(), userUpdatedEvent()]);
    const lastSeq = pushed.body.accepted[1].serverSeq as string;

    const client = await connect(url, a.token);
    expect(await client.next(1)).toEqual({ type: 'hello', branchId: a.branchId, upTo: lastSeq });
    client.ws.close();
  });

  it('avisa a la sucursal tras un push aceptado, sin cruzar tenants', async () => {
    const url = await t.listen();
    const a = await t.pairedDevice();
    const b = await t.pairAnother(a.branchId);
    const otherBranch = await t.pairedDevice({ orgId: a.orgId });
    const otherOrg = await t.pairedDevice();

    const listenerB = await connect(url, b.token);
    const listenerOther = await connect(url, otherBranch.token);
    const listenerOrg = await connect(url, otherOrg.token);
    await Promise.all([listenerB.next(1), listenerOther.next(1), listenerOrg.next(1)]);

    const event = userUpdatedEvent();
    const pushed = await t.push(a.token, [event]);
    expect(await listenerB.next(2)).toEqual({
      type: 'events',
      upTo: pushed.body.accepted[0].serverSeq,
    });

    // Un reenvío (duplicado) no genera aviso.
    await t.push(a.token, [event]);
    await settle();
    expect(listenerB.messages).toHaveLength(2);
    expect(listenerOther.messages).toHaveLength(1);
    expect(listenerOrg.messages).toHaveLength(1);

    for (const l of [listenerB, listenerOther, listenerOrg]) l.ws.close();
  });

  it('revocar el dispositivo cierra su socket con 4401', async () => {
    const url = await t.listen();
    const a = await t.pairedDevice();
    const client = await connect(url, a.token);
    await client.next(1);

    await t.admin().post(`/devices/${a.deviceId}/revoke`);
    expect(await client.closed).toBe(CLOSE_REVOKED);
  });
});
