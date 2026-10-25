/// Espejo de `permissionsFor` de la app (boba_pos/lib/features/users/domain/
/// permissions.dart). Si cambia allá, cambia aquí.
export type Permission =
  | 'sell'
  | 'takeOrders'
  | 'history'
  | 'cashShift'
  | 'expenses'
  | 'inventoryView'
  | 'inventoryEntries'
  | 'inventoryAdjust'
  | 'dashboard'
  | 'manageUsers';

const CASHIER: ReadonlySet<Permission> = new Set([
  'sell',
  'takeOrders',
  'history',
  'cashShift',
  'expenses',
  'inventoryView',
  'inventoryEntries',
]);

export function roleCan(role: string, permission: Permission): boolean {
  switch (role) {
    case 'admin':
      return true;
    case 'cashier':
      return CASHIER.has(permission);
    case 'waiter':
      return permission === 'takeOrders';
    default:
      return false;
  }
}

type Payload = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Payload | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Payload) : null;

/// Quién hizo la operación (`null`: seed/configuración, sin sesión) y qué
/// permiso exige. `user.*` y el catálogo no traen actor: no se validan.
export function actorAndPermission(
  type: string,
  payload: Payload,
): { actor: string | null; permission: Permission } | null {
  switch (type) {
    case 'sale.created':
      return { actor: str(obj(payload.sale)?.userId), permission: 'sell' };
    case 'cash_movement.created':
      return { actor: str(payload.userId), permission: 'expenses' };
    case 'supply_movement.created':
      return {
        actor: str(payload.userId),
        permission:
          payload.kind === 'entry' || payload.kind === 'waste'
            ? 'inventoryEntries'
            : 'inventoryAdjust',
      };
    case 'shift.opened':
      return { actor: str(payload.openedByUserId), permission: 'cashShift' };
    case 'shift.closed':
      return { actor: str(payload.closedByUserId), permission: 'cashShift' };
    case 'incoming_order.created':
    case 'incoming_order.cancelled':
      return { actor: str(payload.createdByUserId), permission: 'takeOrders' };
    default:
      return null;
  }
}
