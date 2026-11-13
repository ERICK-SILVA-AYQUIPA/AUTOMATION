-- Entrega de sistemas (ADR 044): solo la plataforma (rol de sistema) la usa.
CREATE TYPE "DeliveryStatus" AS ENUM ('DRAFT', 'GENERATED', 'DELIVERED');

CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "system_name" TEXT NOT NULL,
    "deployment_mode" "DeploymentMode" NOT NULL,
    "app_version" TEXT NOT NULL,
    "domain" TEXT,
    "support_contact" TEXT NOT NULL,
    "notes" TEXT,
    "manifest" JSONB NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'DRAFT',
    "package_sha256" CHAR(64),
    "package_bytes" INTEGER,
    "generated_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "deliveries_system_name_check" CHECK (length(btrim(system_name)) BETWEEN 2 AND 120),
    CONSTRAINT "deliveries_manifest_check" CHECK (jsonb_typeof(manifest) = 'object'),
    CONSTRAINT "deliveries_package_check" CHECK ((status = 'DRAFT') OR (package_sha256 IS NOT NULL AND generated_at IS NOT NULL))
);

CREATE INDEX "deliveries_tenant_id_created_at_idx" ON "deliveries"("tenant_id", "created_at");
CREATE UNIQUE INDEX "deliveries_tenant_id_number_key" ON "deliveries"("tenant_id", "number");
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Las empresas no ven sus entregas (contienen requisitos y datos de instalación
-- que gestiona la plataforma): RLS sin políticas y sin permisos para el rol de ejecución.
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
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
    EXECUTE format('REVOKE ALL ON TABLE deliveries FROM %I', r.name);
  END LOOP;
END $$;
