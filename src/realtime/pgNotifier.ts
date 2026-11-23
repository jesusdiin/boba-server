import { randomUUID } from 'node:crypto';

import pg from 'pg';
import type { Logger } from 'pino';

import type { Db } from '../db.js';
import {
  CLOSE_REVOKED,
  InProcessBranchNotifier,
  type BranchNotifier,
  type RealtimeConnection,
} from './branchNotifier.js';

export const REALTIME_CHANNEL = 'boba_realtime';

/// Aviso entre instancias (por `pg_notify`; siempre < 8 KB).
type Broadcast =
  | { from: string; kind: 'events'; branchId: string; upTo: string }
  | { from: string; kind: 'plan'; branchId: string }
  | { from: string; kind: 'disconnect'; deviceId: string; code: number; reason: string };

/// Reparte avisos entre varias instancias del servidor con Postgres
/// `LISTEN/NOTIFY`: entrega primero a los sockets de esta instancia y publica
/// para las demás. Perder un aviso no pierde datos (la app hace pull
/// periódico); solo llega más tarde.
export class PgBranchNotifier implements BranchNotifier {
  readonly instanceId = randomUUID();
  private readonly local = new InProcessBranchNotifier();
  private client: pg.Client | null = null;
  private closed = false;
  private retryMs = 1000;
  private retry: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly databaseUrl: string,
    private readonly logger?: Logger,
  ) {}

  /// Empieza a escuchar; resuelve cuando ya escucha (o falla el primer intento).
  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const client = new pg.Client({ connectionString: this.databaseUrl });
    client.on('notification', (msg) => this.receive(msg.payload));
    client.on('error', (err) => {
      this.logger?.warn({ err }, 'realtime: se perdió LISTEN');
      this.reconnect(client);
    });
    client.on('end', () => this.reconnect(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${REALTIME_CHANNEL}`);
      this.client = client;
      this.retryMs = 1000;
    } catch (err) {
      this.logger?.warn({ err }, 'realtime: no se pudo escuchar; reintento');
      this.reconnect(client);
    }
  }

  private reconnect(client: pg.Client): void {
    if (this.closed || this.retry) return;
    if (this.client === client) this.client = null;
    client.removeAllListeners();
    void client.end().catch(() => {});
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, this.retryMs);
    this.retry.unref();
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }

  private receive(payload: string | undefined): void {
    if (!payload) return;
    let m: Broadcast;
    try {
      m = JSON.parse(payload) as Broadcast;
    } catch {
      return;
    }
    if (m.from === this.instanceId) return;
    switch (m.kind) {
      case 'events':
        this.local.notify(m.branchId, BigInt(m.upTo));
        break;
      case 'plan':
        this.local.notifyPlan(m.branchId);
        break;
      case 'disconnect':
        this.local.disconnectDevice(m.deviceId, m.code, m.reason);
        break;
    }
  }

  private publish(message: Broadcast): void {
    const payload = JSON.stringify(message);
    void this.db.$executeRaw`SELECT pg_notify(${REALTIME_CHANNEL}, ${payload})`.catch(
      (err: unknown) => this.logger?.warn({ err }, 'realtime: no se publicó'),
    );
  }

  add(connection: RealtimeConnection): void {
    this.local.add(connection);
  }

  remove(connection: RealtimeConnection): void {
    this.local.remove(connection);
  }

  notify(branchId: string, upTo: bigint): void {
    this.local.notify(branchId, upTo);
    this.publish({
      from: this.instanceId,
      kind: 'events',
      branchId,
      upTo: upTo.toString(),
    });
  }

  notifyPlan(branchId: string): void {
    this.local.notifyPlan(branchId);
    this.publish({ from: this.instanceId, kind: 'plan', branchId });
  }

  disconnectDevice(deviceId: string, code = CLOSE_REVOKED, reason = 'revoked'): void {
    this.local.disconnectDevice(deviceId, code, reason);
    this.publish({ from: this.instanceId, kind: 'disconnect', deviceId, code, reason });
  }

  connectionCount(branchId: string): number {
    return this.local.connectionCount(branchId);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners();
      await client.end().catch(() => {});
    }
  }
}
