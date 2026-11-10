-- Bandeja de salida de eventos hacia n8n (FASE 4, flujos 3, 4 y 7)

CREATE TYPE "AutomationEventStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "automation_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" "AutomationKey" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "AutomationEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "notified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automation_events_status_next_attempt_at_idx" ON "automation_events"("status", "next_attempt_at");
CREATE INDEX "automation_events_tenant_id_created_at_idx" ON "automation_events"("tenant_id", "created_at");

-- La API (rol de ejecución) solo escribe/lee eventos de su empresa; la entrega
-- la hace el worker con el rol de sistema.
ALTER TABLE "automation_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "automation_events"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
