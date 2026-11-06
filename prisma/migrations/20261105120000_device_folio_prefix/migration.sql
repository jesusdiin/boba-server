-- Letra de folio por equipo: A, B… Z, AA… en orden de alta dentro de la
-- sucursal (incluye los desconectados, para no reutilizar letras).
ALTER TABLE "devices" ADD COLUMN "folio_prefix" TEXT;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY branch_id ORDER BY created_at, id) - 1 AS n
  FROM "devices"
)
UPDATE "devices" d
SET "folio_prefix" = CASE
  WHEN r.n < 26 THEN chr(65 + r.n::int)
  ELSE chr(64 + (r.n::int / 26)) || chr(65 + (r.n::int % 26))
END
FROM ranked r
WHERE d.id = r.id;

ALTER TABLE "devices" ALTER COLUMN "folio_prefix" SET NOT NULL;

CREATE UNIQUE INDEX "devices_branch_id_folio_prefix_key" ON "devices"("branch_id", "folio_prefix");
