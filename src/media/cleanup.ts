import type { Db } from '../db.js';

/// Días que una foto puede quedar sin usar antes de borrarla: cubre la que se
/// subió pero cuyo producto aún no llega (equipo sin conexión) y da margen
/// para deshacer un cambio.
export const MEDIA_GRACE_DAYS = 7;

/// Borra las fotos que ningún producto ni sabor del negocio usa
/// (`imagePath = "media:<id>"` en la fila vigente) y que tienen más de
/// [graceDays] días. Devuelve cuántas se borraron.
export async function purgeUnusedMedia(
  db: Db,
  graceDays = MEDIA_GRACE_DAYS,
): Promise<number> {
  return db.$executeRaw`
    DELETE FROM media m
     WHERE m.created_at < now() - make_interval(days => ${graceDays})
       AND NOT EXISTS (
         SELECT 1
           FROM aggregate_state a
           JOIN branches b ON b.id = a.branch_id
          WHERE b.organization_id = m.organization_id
            AND a.aggregate_type IN ('product', 'modifier_option')
            AND a.row->>'imagePath' = 'media:' || m.id::text
       )`;
}
