import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Logger } from 'pino';
import { WebSocket, WebSocketServer } from 'ws';

import { bearerToken, resolveDevice, type DeviceContext } from '../auth/deviceAuth.js';
import type { Db } from '../db.js';
import type { BranchNotifier, RealtimeConnection, RealtimeMessage } from './branchNotifier.js';

export const REALTIME_PATH = '/v1/ws';

export interface RealtimeDeps {
  db: Db;
  notifier: BranchNotifier;
  logger: Logger;
  /// Cada cuánto se verifica que el socket siga vivo (ping/pong).
  heartbeatMs?: number;
}

/// `GET /v1/ws` (upgrade). Autentica con el mismo token de dispositivo que el
/// sync REST y solo envía avisos `{type: 'events', upTo}`: los datos se
/// siguen bajando con el pull, así que perder un aviso no pierde datos.
export function attachRealtime(
  server: Server,
  { db, notifier, logger, heartbeatMs = 30_000 }: RealtimeDeps,
): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head);
  });

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== REALTIME_PATH) return reject(socket, 404, 'Not Found');
    const token = bearerToken(req.headers.authorization);
    let device: DeviceContext | null;
    try {
      device = token ? await resolveDevice(db, token) : null;
    } catch (err) {
      logger.error({ err }, 'ws auth');
      return reject(socket, 500, 'Internal Server Error');
    }
    if (!device) return reject(socket, 401, 'Unauthorized');
    const ctx = device;
    wss.handleUpgrade(req, socket, head, (ws) => void onConnection(ws, ctx));
  }

  async function onConnection(ws: WebSocket, device: DeviceContext) {
    const connection: RealtimeConnection = {
      deviceId: device.id,
      branchId: device.branchId,
      send: (message: RealtimeMessage) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('close', () => notifier.remove(connection));
    ws.on('error', (err) => logger.warn({ err, deviceId: device.id }, 'ws error'));
    // Mensajes del cliente: no se esperan (solo pong a nivel de protocolo).
    ws.on('message', () => {});
    notifier.add(connection);

    const last = await db.event.findFirst({
      where: { branchId: device.branchId },
      orderBy: { serverSeq: 'desc' },
      select: { serverSeq: true },
    });
    connection.send({
      type: 'hello',
      branchId: device.branchId,
      upTo: (last?.serverSeq ?? 0n).toString(),
    });
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    close: () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
