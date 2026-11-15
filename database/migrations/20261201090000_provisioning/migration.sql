-- Orquestador de aprovisionamiento (ADR 051): una ejecución por orden de
-- instalación pagada que avanza por pasos (cola y worker), con reintentos
-- limitados, plazos, intervención humana y un historial que solo se agrega.
-- Solo el rol de sistema.

CREATE TYPE "ProvisioningStatus" AS ENUM (
  'REQUESTED', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'PREPARING', 'CREATING_INFRA', 'SERVER_READY',
  'CONFIGURING_SERVER', 'INSTALLING', 'MIGRATING', 'CONFIGURING_INTEGRATIONS', 'TESTING', 'PUBLISHING',
  'DELIVERING', 'DELIVERED', 'ERROR', 'CANCELLED', 'NEEDS_INTERVENTION'
);

CREATE TABLE "provisioning_runs" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "installation_order_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "server_type" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "admin_email" TEXT NOT NULL,
    -- Datos no secretos de la instalación (SMTP, remitente…)
    "settings" JSONB NOT NULL DEFAULT '{}',
    -- Secretos cifrados con DATA_ENCRYPTION_KEY (contraseña SMTP, token de arranque); se borran al entregar
    "secrets_enc" TEXT,
    "status" "ProvisioningStatus" NOT NULL DEFAULT 'REQUESTED',
    -- Paso en el que se detuvo (ERROR o NEEDS_INTERVENTION): reintentar vuelve aquí
    "stopped_at" "ProvisioningStatus",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMPTZ(3),
    "step_started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "step_deadline_at" TIMESTAMPTZ(3),
    -- Arriendo: un solo worker avanza la ejecución a la vez
    "lease_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "needs" TEXT,
    "server_request_id" UUID,
    "server_id" UUID,
    -- Token de arranque del servidor (un solo uso) y token del agente: solo el SHA-256
    "bootstrap_hash" TEXT,
    "bootstrap_expires_at" TIMESTAMPTZ(3),
    "bootstrap_used_at" TIMESTAMPTZ(3),
    "agent_hash" TEXT,
    "agent_seen_at" TIMESTAMPTZ(3),
    "alerted_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    CONSTRAINT "provisioning_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provisioning_runs_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "provisioning_runs_stopped_check" CHECK (("status" IN ('ERROR', 'NEEDS_INTERVENTION')) = ("stopped_at" IS NOT NULL)),
    CONSTRAINT "provisioning_runs_cancel_check" CHECK ("status" <> 'CANCELLED' OR "cancel_reason" IS NOT NULL)
);
CREATE UNIQUE INDEX "provisioning_runs_number_key" ON "provisioning_runs"("number");
-- Una sola ejecución no cancelada por orden de instalación (no se instala ni se cobra dos veces)
CREATE UNIQUE INDEX "provisioning_runs_install_key" ON "provisioning_runs"("installation_order_id") WHERE "status" <> 'CANCELLED';
CREATE INDEX "provisioning_runs_due_idx" ON "provisioning_runs"("next_run_at") WHERE "next_run_at" IS NOT NULL;

CREATE TABLE "provisioning_events" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "status" "ProvisioningStatus" NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provisioning_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provisioning_events_level_check" CHECK ("level" IN ('info', 'warn', 'error')),
    CONSTRAINT "provisioning_events_source_check" CHECK ("source" IN ('engine', 'user', 'agent'))
);
CREATE INDEX "provisioning_events_run_idx" ON "provisioning_events"("run_id", "created_at");

ALTER TABLE "provisioning_runs" ADD CONSTRAINT "provisioning_runs_installation_order_id_fkey" FOREIGN KEY ("installation_order_id") REFERENCES "installation_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provisioning_runs" ADD CONSTRAINT "provisioning_runs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "infra_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provisioning_runs" ADD CONSTRAINT "provisioning_runs_server_request_id_fkey" FOREIGN KEY ("server_request_id") REFERENCES "infra_server_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provisioning_runs" ADD CONSTRAINT "provisioning_runs_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "infra_servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provisioning_events" ADD CONSTRAINT "provisioning_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "provisioning_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El historial no se modifica ni se borra; las ejecuciones tampoco se borran
CREATE TRIGGER provisioning_events_append_only BEFORE UPDATE OR DELETE ON "provisioning_events" FOR EACH ROW EXECUTE FUNCTION commercial_append_only();
CREATE TRIGGER provisioning_runs_no_delete BEFORE DELETE ON "provisioning_runs" FOR EACH ROW EXECUTE FUNCTION commercial_append_only();

ALTER TABLE "provisioning_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provisioning_events" ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r record; t text;
BEGIN
  FOR r IN
    SELECT DISTINCT g.grantee AS name
    FROM information_schema.role_table_grants g
    JOIN pg_roles ro ON ro.rolname = g.grantee
    WHERE g.table_schema = 'public' AND g.table_name = 'users' AND g.privilege_type = 'UPDATE'
      AND g.grantee <> current_user AND NOT ro.rolsuper AND NOT ro.rolbypassrls
  LOOP
    FOREACH t IN ARRAY ARRAY['provisioning_runs', 'provisioning_events']
    LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r.name);
    END LOOP;
    EXECUTE format('REVOKE ALL ON SEQUENCE %I FROM %I', 'provisioning_runs_number_seq', r.name);
  END LOOP;
END $$;
