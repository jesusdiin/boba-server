import type { Db } from '../db.js';

/// Conexión de tiempo real de un dispositivo (un socket abierto).
export interface RealtimeConnection {
  readonly deviceId: string;
  readonly branchId: string;
  send(message: RealtimeMessage): void;
  close(code: number, reason: string): void;
}

/// Mensajes del servidor al dispositivo: solo avisos, nunca datos de negocio.
/// `upTo` es el `serverSeq` (string, como en el pull) hasta el que hay eventos.
export type RealtimeMessage =
  | { type: 'hello'; branchId: string; upTo: string }
  | { type: 'events'; upTo: string }
  /// El plan de la organización cambió (panel, cupón, tienda): que el
  /// dispositivo haga pull para recibirlo. Las apps viejas lo ignoran.
  | { type: 'plan' };

/// Cierre por dispositivo revocado (el cliente deja de reconectar).
export const CLOSE_REVOKED = 4401;
/// Cierre porque el equipo cambió de sucursal: el cliente reconecta (y el
/// nuevo socket ya es de la otra sucursal).
export const CLOSE_MOVED = 4409;

/// Reparte avisos a los dispositivos conectados de cada sucursal.
export interface BranchNotifier {
  add(connection: RealtimeConnection): void;
  remove(connection: RealtimeConnection): void;
  notify(branchId: string, upTo: bigint): void;
  notifyPlan(branchId: string): void;
  disconnectDevice(deviceId: string, code?: number, reason?: string): void;
}

/// En memoria: basta con una sola instancia del servidor. Con varias, se
/// reemplaza por una implementación sobre Postgres `LISTEN/NOTIFY`.
export class InProcessBranchNotifier implements BranchNotifier {
  private readonly byBranch = new Map<string, Set<RealtimeConnection>>();

  add(connection: RealtimeConnection): void {
    const set = this.byBranch.get(connection.branchId) ?? new Set();
    set.add(connection);
    this.byBranch.set(connection.branchId, set);
  }

  remove(connection: RealtimeConnection): void {
    const set = this.byBranch.get(connection.branchId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) this.byBranch.delete(connection.branchId);
  }

  notify(branchId: string, upTo: bigint): void {
    for (const c of this.byBranch.get(branchId) ?? []) {
      c.send({ type: 'events', upTo: upTo.toString() });
    }
  }

  notifyPlan(branchId: string): void {
    for (const c of this.byBranch.get(branchId) ?? []) c.send({ type: 'plan' });
  }

  disconnectDevice(deviceId: string, code = CLOSE_REVOKED, reason = 'revoked'): void {
    for (const set of this.byBranch.values()) {
      for (const c of set) {
        if (c.deviceId === deviceId) c.close(code, reason);
      }
    }
  }

  connectionCount(branchId: string): number {
    return this.byBranch.get(branchId)?.size ?? 0;
  }
}

/// Sin tiempo real (tests HTTP).
export const noopNotifier: BranchNotifier = {
  add: () => {},
  remove: () => {},
  notify: () => {},
  notifyPlan: () => {},
  disconnectDevice: () => {},
};

/// Avisa a todas las sucursales de la organización que su plan cambió.
export async function notifyPlanChanged(
  db: Db,
  notifier: BranchNotifier,
  organizationId: string,
): Promise<void> {
  const branches = await db.branch.findMany({
    where: { organizationId },
    select: { id: true },
  });
  for (const b of branches) notifier.notifyPlan(b.id);
}
