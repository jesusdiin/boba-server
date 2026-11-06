-- Contacto de la sucursal y momento del último `branch.details_set`.
ALTER TABLE "branches" ADD COLUMN "address" TEXT;
ALTER TABLE "branches" ADD COLUMN "phone" TEXT;
ALTER TABLE "branches" ADD COLUMN "whatsapp" TEXT;
ALTER TABLE "branches" ADD COLUMN "instagram" TEXT;
ALTER TABLE "branches" ADD COLUMN "details_set_at" TIMESTAMPTZ(3);
