type Row = Record<string, unknown>;

/// Booleanos que la app exige en cada fila (Drift los lee como `bool`, no
/// `bool?`). Una fila subida por una versión vieja de la app, antes de que
/// existiera la columna, llega sin ellos: se rellenan con el valor por
/// omisión de la app al guardar, en el snapshot y en el pull.
const DEFAULTS: Readonly<Record<string, Row>> = {
  category: { isActive: true },
  product: { isActive: true, isSoldOut: false },
  modifier_group: { isActive: true },
  modifier_option: { isActive: true },
  supply: { isActive: true },
  user: { isActive: true },
};

/// Tipo de evento → tipo de fila.
const EVENT_KINDS: Readonly<Record<string, string>> = {
  'category.upserted': 'category',
  'product.upserted': 'product',
  'modifier_group.upserted': 'modifier_group',
  'modifier_option.upserted': 'modifier_option',
  'supply.upserted': 'supply',
  'user.created': 'user',
  'user.updated': 'user',
};

/// Copia de [row] con los booleanos faltantes (o `null`) rellenos. Nunca
/// pisa un valor existente; otros tipos de fila salen tal cual.
export function withRowDefaults<T>(kind: string, row: T): T {
  const defaults = DEFAULTS[kind];
  if (!defaults || !row || typeof row !== 'object' || Array.isArray(row)) return row;
  const source = row as Row;
  let out: Row | null = null;
  for (const [key, value] of Object.entries(defaults)) {
    if (source[key] === undefined || source[key] === null) {
      out ??= { ...source };
      out[key] = value;
    }
  }
  return (out ?? row) as T;
}

/// [withRowDefaults] para el payload de un evento (según su tipo).
export function withEventDefaults<T>(type: string, payload: T): T {
  const kind = EVENT_KINDS[type];
  return kind ? withRowDefaults(kind, payload) : payload;
}
