-- Cuenta del Dueño: su correo verificado y los códigos que se le envían.
CREATE TABLE IF NOT EXISTS "owner_accounts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "owner_accounts_user_id_key" ON "owner_accounts"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "owner_accounts_email_key" ON "owner_accounts"("email");
CREATE INDEX IF NOT EXISTS "owner_accounts_organization_id_idx" ON "owner_accounts"("organization_id");
DO $$ BEGIN
  ALTER TABLE "owner_accounts" ADD CONSTRAINT "owner_accounts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "email_codes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_codes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "email_codes_user_id_purpose_idx" ON "email_codes"("user_id", "purpose");
DO $$ BEGIN
  ALTER TABLE "email_codes" ADD CONSTRAINT "email_codes_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
