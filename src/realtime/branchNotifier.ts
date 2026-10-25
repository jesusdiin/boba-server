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
  | { type: 'events'; upTo: string };

/// Cierre por dispositivo revocado (el cliente deja de reconectar).
export const CLOSE_REVOKED = 4401;

/// Reparte avisos a los dispositivos conectados de cada sucursal.
export interface BranchNotifier {
  add(connection: RealtimeConnection): void;
  remove(connection: RealtimeConnection): void;
  notify(branchId: string, upTo: bigint): void;
  disconnectDevice(deviceId: string): void;
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

  disconnectDevice(deviceId: string): void {
    for (const set of this.byBranch.values()) {
      for (const c of set) {
        if (c.deviceId === deviceId) c.close(CLOSE_REVOKED, 'revoked');
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
  disconnectDevice: () => {},
};
