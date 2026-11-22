-- Conflictos revisados desde la app (admin o Dueño de la sucursal).
ALTER TABLE "sync_conflicts" ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMPTZ(3);
ALTER TABLE "sync_conflicts" ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" UUID;
CREATE INDEX IF NOT EXISTS "sync_conflicts_branch_id_reviewed_at_idx"
    ON "sync_conflicts"("branch_id", "reviewed_at");
