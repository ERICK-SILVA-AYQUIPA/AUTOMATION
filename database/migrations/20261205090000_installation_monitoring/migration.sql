-- Monitoreo de las instalaciones entregadas (ADR 052): el servidor del cliente
-- reporta cada 10 minutos su salud y la puesta en marcha (WhatsApp, IA, catálogo,
-- automatizaciones) con un token propio de solo reporte (se guarda su SHA-256).
ALTER TABLE "provisioning_runs"
  ADD COLUMN "monitor_hash" TEXT,
  ADD COLUMN "last_report_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_report" JSONB,
  ADD COLUMN "report_alerted_at" TIMESTAMPTZ(3);
CREATE INDEX "provisioning_runs_monitor_idx" ON "provisioning_runs"("last_report_at") WHERE "monitor_hash" IS NOT NULL;
