-- Fase 4 de la evolución: catálogo de automatizaciones (ADR 040).
ALTER TYPE "AutomationEventStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';
ALTER TYPE "AutomationKey" ADD VALUE IF NOT EXISTS 'PENDING_ORDER_REMINDER';

ALTER TABLE "automation_events" ADD COLUMN "dedupe_key" TEXT,
ADD COLUMN "retried_by_id" UUID;

ALTER TABLE "automations" ADD COLUMN "updated_by_id" UUID,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX "automation_events_tenant_id_key_dedupe_key_key" ON "automation_events"("tenant_id", "key", "dedupe_key");
