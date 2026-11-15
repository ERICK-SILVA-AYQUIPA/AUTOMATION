-- Gestor de infraestructura (ADR 050): proveedores con token cifrado, límites y
-- presupuesto; solicitudes de servidor que necesitan aprobación; servidores y un
-- registro de operaciones que solo se agrega. Solo el rol de sistema.

CREATE TYPE "InfraKind" AS ENUM ('HETZNER');
CREATE TYPE "ServerRequestStatus" AS ENUM ('PENDING_APPROVAL', 'REJECTED', 'CANCELLED', 'CREATING', 'CREATED', 'FAILED');

CREATE TABLE "infra_providers" (
    "id" UUID NOT NULL,
    "kind" "InfraKind" NOT NULL,
    "label" TEXT NOT NULL,
    "secrets_enc" TEXT NOT NULL,
    "secret_hint" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'INCOMPLETE',
    "last_error" TEXT,
    "last_checked_at" TIMESTAMPTZ(3),
    "connected_at" TIMESTAMPTZ(3),
    "rotated_at" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "currency" CHAR(3),
    -- Límites: sin presupuesto no se crea ningún servidor
    "monthly_budget" DECIMAL(12,2),
    "max_servers" INTEGER,
    "allowed_locations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowed_server_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "default_image" TEXT NOT NULL DEFAULT 'ubuntu-24.04',
    -- Direcciones (CIDR) desde las que se permite SSH; vacío = SSH cerrado en el firewall
    "ssh_source_cidrs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "infra_providers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "infra_providers_budget_check" CHECK ("monthly_budget" IS NULL OR "monthly_budget" > 0),
    CONSTRAINT "infra_providers_max_check" CHECK ("max_servers" IS NULL OR "max_servers" >= 0)
);

-- Claves SSH públicas (nunca privadas) que se instalan en los servidores creados
CREATE TABLE "infra_ssh_keys" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "infra_ssh_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "infra_ssh_keys_fingerprint_key" ON "infra_ssh_keys"("fingerprint");

CREATE TABLE "infra_server_requests" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "provider_id" UUID NOT NULL,
    "installation_order_id" UUID,
    "purpose" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "server_type" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "price_hourly" DECIMAL(12,4) NOT NULL,
    "price_monthly" DECIMAL(12,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "ServerRequestStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "infra_server_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "infra_server_requests_decided_check" CHECK ("status" IN ('PENDING_APPROVAL', 'CANCELLED') OR "decided_at" IS NOT NULL)
);
CREATE UNIQUE INDEX "infra_server_requests_number_key" ON "infra_server_requests"("number");
CREATE INDEX "infra_server_requests_status_idx" ON "infra_server_requests"("status");
-- Una sola solicitud viva por orden de instalación
CREATE UNIQUE INDEX "infra_server_requests_install_key" ON "infra_server_requests"("installation_order_id") WHERE "installation_order_id" IS NOT NULL AND "status" IN ('PENDING_APPROVAL', 'CREATING', 'CREATED');

CREATE TABLE "infra_servers" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "request_id" UUID,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "server_type" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "image" TEXT,
    "ipv4" TEXT,
    "ipv6" TEXT,
    "firewall_external_id" TEXT,
    "price_hourly" DECIMAL(12,4),
    "price_monthly" DECIMAL(12,4),
    "currency" CHAR(3),
    "installation_order_id" UUID,
    "tenant_id" UUID,
    "imported" BOOLEAN NOT NULL DEFAULT false,
    "provider_created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_synced_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by_id" UUID,
    "delete_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "infra_servers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "infra_servers_deleted_check" CHECK ("deleted_at" IS NULL OR "delete_reason" IS NOT NULL)
);
CREATE UNIQUE INDEX "infra_servers_provider_external_key" ON "infra_servers"("provider_id", "external_id");
CREATE UNIQUE INDEX "infra_servers_request_key" ON "infra_servers"("request_id");

CREATE TABLE "infra_operations" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "server_id" UUID,
    "request_id" UUID,
    "kind" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "infra_operations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "infra_operations_provider_created_idx" ON "infra_operations"("provider_id", "created_at");
CREATE INDEX "infra_operations_server_idx" ON "infra_operations"("server_id");

ALTER TABLE "infra_server_requests" ADD CONSTRAINT "infra_server_requests_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "infra_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "infra_server_requests" ADD CONSTRAINT "infra_server_requests_installation_order_id_fkey" FOREIGN KEY ("installation_order_id") REFERENCES "installation_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "infra_servers" ADD CONSTRAINT "infra_servers_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "infra_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "infra_servers" ADD CONSTRAINT "infra_servers_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "infra_server_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "infra_servers" ADD CONSTRAINT "infra_servers_installation_order_id_fkey" FOREIGN KEY ("installation_order_id") REFERENCES "installation_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "infra_servers" ADD CONSTRAINT "infra_servers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "infra_operations" ADD CONSTRAINT "infra_operations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "infra_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "infra_operations" ADD CONSTRAINT "infra_operations_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "infra_servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "infra_operations" ADD CONSTRAINT "infra_operations_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "infra_server_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El registro de operaciones no se modifica ni se borra
CREATE TRIGGER infra_operations_append_only BEFORE UPDATE OR DELETE ON "infra_operations" FOR EACH ROW EXECUTE FUNCTION commercial_append_only();
-- Un servidor no se borra de la base: se marca eliminado con motivo
CREATE TRIGGER infra_servers_no_delete BEFORE DELETE ON "infra_servers" FOR EACH ROW EXECUTE FUNCTION commercial_append_only();

ALTER TABLE "infra_providers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "infra_ssh_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "infra_server_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "infra_servers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "infra_operations" ENABLE ROW LEVEL SECURITY;

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
    FOREACH t IN ARRAY ARRAY['infra_providers', 'infra_ssh_keys', 'infra_server_requests', 'infra_servers', 'infra_operations']
    LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r.name);
    END LOOP;
    EXECUTE format('REVOKE ALL ON SEQUENCE %I FROM %I', 'infra_server_requests_number_seq', r.name);
  END LOOP;
END $$;
