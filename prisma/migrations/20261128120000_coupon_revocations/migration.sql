-- Canje revocado desde el panel (el negocio volvió a su plan anterior).
ALTER TABLE "coupon_redemptions" ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(3);
