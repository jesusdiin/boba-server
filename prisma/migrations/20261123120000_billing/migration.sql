-- Cobro en la app (RevenueCat): origen del plan y webhooks procesados.
CREATE TYPE "billing_source" AS ENUM ('manual', 'store');

ALTER TABLE "organizations"
  ADD COLUMN "billing_source" "billing_source" NOT NULL DEFAULT 'manual';

CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "organization_id" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "billing_events_organization_id_idx" ON "billing_events"("organization_id");

ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
