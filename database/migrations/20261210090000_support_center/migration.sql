-- Postventa (ADR 054): centro de soporte con incidencias y encuesta de
-- satisfacción, y avisos de vencimiento de la suscripción.
CREATE TYPE "SupportKind" AS ENUM ('QUESTION', 'INCIDENT', 'REQUEST', 'BILLING');
CREATE TYPE "SupportPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "SupportStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_CLIENT', 'RESOLVED', 'CLOSED');
CREATE TYPE "SupportSource" AS ENUM ('TENANT', 'PLATFORM', 'MONITOR');
CREATE TYPE "SupportAuthor" AS ENUM ('CLIENT', 'STAFF', 'SYSTEM');

CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "SupportKind" NOT NULL,
    "priority" "SupportPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "SupportStatus" NOT NULL DEFAULT 'OPEN',
    "source" "SupportSource" NOT NULL,
    "subject" TEXT NOT NULL,
    "created_by_id" UUID,
    "assignee_id" UUID,
    "provisioning_run_id" UUID,
    "first_response_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "rating" SMALLINT,
    "rating_comment" TEXT,
    "rated_at" TIMESTAMPTZ(3),
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_tickets_rating_check" CHECK ("rating" IS NULL OR ("rating" BETWEEN 1 AND 5 AND "resolved_at" IS NOT NULL)),
    CONSTRAINT "support_tickets_subject_check" CHECK (length("subject") BETWEEN 3 AND 200)
);
CREATE UNIQUE INDEX "support_tickets_number_key" ON "support_tickets"("number");
CREATE INDEX "support_tickets_tenant_idx" ON "support_tickets"("tenant_id", "created_at");
CREATE INDEX "support_tickets_open_idx" ON "support_tickets"("status", "priority", "last_activity_at");
-- Una sola incidencia abierta por instalación detectada por el monitoreo
CREATE UNIQUE INDEX "support_tickets_monitor_open_key" ON "support_tickets"("provisioning_run_id") WHERE "source" = 'MONITOR' AND "status" NOT IN ('RESOLVED', 'CLOSED');
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_provisioning_run_id_fkey" FOREIGN KEY ("provisioning_run_id") REFERENCES "provisioning_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "author_kind" "SupportAuthor" NOT NULL,
    "author_id" UUID,
    "body" TEXT NOT NULL,
    -- Nota interna del equipo: la empresa nunca la ve
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_messages_body_check" CHECK (length("body") BETWEEN 1 AND 10000),
    CONSTRAINT "support_messages_internal_check" CHECK (NOT "internal" OR "author_kind" <> 'CLIENT')
);
CREATE INDEX "support_messages_ticket_idx" ON "support_messages"("ticket_id", "created_at");
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TRIGGER support_messages_append_only BEFORE UPDATE ON "support_messages" FOR EACH ROW EXECUTE FUNCTION commercial_append_only();

-- La empresa ve y crea solo lo suyo; nunca las notas internas
ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON support_tickets FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_insert ON support_tickets FOR INSERT WITH CHECK (tenant_id = app_current_tenant() AND source = 'TENANT' AND assignee_id IS NULL);
CREATE POLICY tenant_update ON support_tickets FOR UPDATE USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "support_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON support_messages FOR SELECT USING (tenant_id = app_current_tenant() AND NOT internal);
CREATE POLICY tenant_insert ON support_messages FOR INSERT WITH CHECK (tenant_id = app_current_tenant() AND NOT internal AND author_kind = 'CLIENT');

-- Avisos de vencimiento ya enviados (uno por periodo y tipo): solo la plataforma
CREATE TABLE "subscription_notices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "subscription_notices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_notices_kind_check" CHECK ("kind" IN ('D7', 'D3', 'D1', 'EXPIRED'))
);
CREATE UNIQUE INDEX "subscription_notices_once_key" ON "subscription_notices"("tenant_id", "period_end", "kind");
ALTER TABLE "subscription_notices" ADD CONSTRAINT "subscription_notices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_notices" ENABLE ROW LEVEL SECURITY;
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
    EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', 'subscription_notices', r.name);
  END LOOP;
END $$;
