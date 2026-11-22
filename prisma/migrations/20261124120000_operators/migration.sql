-- Panel del operador (boba_admin): operadores, sesiones y bitácora.
CREATE TABLE IF NOT EXISTS "operators" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMPTZ(3),

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "operators_email_key" ON "operators"("email");

CREATE TABLE IF NOT EXISTS "operator_sessions" (
    "token_hash" TEXT NOT NULL,
    "operator_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_sessions_pkey" PRIMARY KEY ("token_hash"),
    CONSTRAINT "operator_sessions_operator_id_fkey" FOREIGN KEY ("operator_id")
      REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "operator_sessions_operator_id_idx" ON "operator_sessions"("operator_id");

CREATE TABLE IF NOT EXISTS "operator_audit" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "organization_id" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_audit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "operator_audit_operator_id_fkey" FOREIGN KEY ("operator_id")
      REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "operator_audit_at_idx" ON "operator_audit"("at");
CREATE INDEX IF NOT EXISTS "operator_audit_organization_id_at_idx" ON "operator_audit"("organization_id", "at");
