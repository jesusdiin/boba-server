-- Cupones (cortesías, licencias, campañas) y sus canjes. Base de referidos:
-- `kind = referral` + `referrer_organization_id`.
CREATE TABLE IF NOT EXISTS "coupons" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "plan" "plan" NOT NULL,
    "duration_days" INTEGER,
    "limit_overrides" JSONB,
    "max_redemptions" INTEGER,
    "redemption_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3),
    "kind" TEXT NOT NULL DEFAULT 'courtesy',
    "referrer_organization_id" UUID,
    "batch_id" UUID,
    "note" TEXT,
    "created_by_operator_id" UUID,
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "coupons_code_key" ON "coupons"("code");
CREATE INDEX IF NOT EXISTS "coupons_batch_id_idx" ON "coupons"("batch_id");
CREATE INDEX IF NOT EXISTS "coupons_referrer_organization_id_idx" ON "coupons"("referrer_organization_id");

CREATE TABLE IF NOT EXISTS "coupon_redemptions" (
    "id" UUID NOT NULL,
    "coupon_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "redeemed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previous_plan" JSONB NOT NULL,
    "resulting_period_end" TIMESTAMPTZ(3),

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "coupon_redemptions_coupon_id_organization_id_key"
    ON "coupon_redemptions"("coupon_id", "organization_id");
CREATE INDEX IF NOT EXISTS "coupon_redemptions_organization_id_idx"
    ON "coupon_redemptions"("organization_id");
DO $$ BEGIN
  ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey"
    FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
