-- Avisos automáticos: tipos que cada instalación apagó en Ajustes (vacío = todos).
ALTER TABLE "push_tokens" ADD COLUMN IF NOT EXISTS "muted_topics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
