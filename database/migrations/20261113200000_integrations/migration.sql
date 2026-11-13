-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "IntegrationType" ADD VALUE 'GEMINI';

-- AlterTable
ALTER TABLE "tenant_integrations" ADD COLUMN     "last_checked_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "integration_checks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "service" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "latency_ms" INTEGER,
    "detail" TEXT,
    "checked_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "secret_enc" TEXT NOT NULL,
    "secret_hint" TEXT NOT NULL,
    "events" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_delivery_at" TIMESTAMPTZ(3),
    "last_status" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "response_status" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_checks_tenant_id_service_created_at_idx" ON "integration_checks"("tenant_id", "service", "created_at");

-- CreateIndex
CREATE INDEX "integration_checks_service_created_at_idx" ON "integration_checks"("service", "created_at");

-- CreateIndex
CREATE INDEX "webhook_endpoints_tenant_id_idx" ON "webhook_endpoints"("tenant_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries"("endpoint_id", "created_at");

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_url_length" CHECK (char_length("url") BETWEEN 8 AND 500);

-- Comprobaciones: la empresa ve y registra las suyas; las de la plataforma (tenant_id null) solo el rol de sistema
ALTER TABLE integration_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON integration_checks FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_insert ON integration_checks FOR INSERT WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_endpoints USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Entregas: la empresa las crea (en la transacción del cambio), las ve y puede reencolarlas; el envío lo hace el worker
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON webhook_deliveries FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_insert ON webhook_deliveries FOR INSERT WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_update ON webhook_deliveries FOR UPDATE USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT g.grantee AS name
    FROM information_schema.role_table_grants g
    JOIN pg_roles ro ON ro.rolname = g.grantee
    WHERE g.table_schema = 'public' AND g.table_name = 'users' AND g.privilege_type = 'UPDATE'
      AND g.grantee <> current_user AND NOT ro.rolsuper AND NOT ro.rolbypassrls
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON TABLE integration_checks FROM %I', r.name);
    EXECUTE format('REVOKE UPDATE, DELETE ON TABLE webhook_deliveries FROM %I', r.name);
    EXECUTE format('GRANT UPDATE (status, attempts, next_attempt_at, last_error) ON TABLE webhook_deliveries TO %I', r.name);
  END LOOP;
END $$;
