-- Planes y suscripción por organización (src/plans.ts). Las existentes
-- quedan en Pro activo sin vencimiento (cortesía).
CREATE TYPE "plan" AS ENUM ('pro', 'max');
CREATE TYPE "subscription_status" AS ENUM ('trialing', 'active', 'past_due', 'canceled');

ALTER TABLE "organizations"
  ADD COLUMN "plan" "plan" NOT NULL DEFAULT 'pro',
  ADD COLUMN "subscription_status" "subscription_status" NOT NULL DEFAULT 'active',
  ADD COLUMN "current_period_end" TIMESTAMPTZ(3),
  ADD COLUMN "limit_overrides" JSONB;
