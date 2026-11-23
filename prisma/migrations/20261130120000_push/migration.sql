-- Notificaciones push: instalaciones registradas y avisos enviados.
CREATE TABLE IF NOT EXISTS "push_tokens" (
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "app_version" TEXT,
    "locale" TEXT,
    "organization_id" UUID,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("token")
);
CREATE INDEX IF NOT EXISTS "push_tokens_organization_id_idx" ON "push_tokens"("organization_id");

CREATE TABLE IF NOT EXISTS "push_campaigns" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "organization_id" UUID,
    "targeted" INTEGER NOT NULL,
    "sent" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "push_campaigns_created_at_idx" ON "push_campaigns"("created_at");
