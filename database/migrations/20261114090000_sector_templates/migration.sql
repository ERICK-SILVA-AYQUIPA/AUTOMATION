-- Plantillas por sector (ADR 043): reglas de operación por empresa, productos
-- sin stock (servicios, platos), precios por volumen, clientes comerciales y reservas.

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('PERSON', 'BUSINESS');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- AlterEnum
ALTER TYPE "AutomationKey" ADD VALUE 'RESERVATION_REMINDER';

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "business_name" TEXT,
ADD COLUMN     "customer_type" "CustomerType" NOT NULL DEFAULT 'PERSON';

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "price_tiers" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "duration_minutes" INTEGER,
ADD COLUMN     "track_stock" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "template_version" INTEGER;

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "customer_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "conversation_id" UUID,
    "product_id" UUID,
    "service_name" TEXT,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "party_size" INTEGER NOT NULL DEFAULT 1,
    "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "channel" "OrderChannel" NOT NULL,
    "notes" TEXT,
    "idempotency_key" TEXT,
    "created_by_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reservations_tenant_id_starts_at_idx" ON "reservations"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_status_starts_at_idx" ON "reservations"("tenant_id", "status", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_tenant_id_number_key" ON "reservations"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_tenant_id_idempotency_key_key" ON "reservations"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id");
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_time_check" CHECK ("ends_at" > "starts_at");
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_party_size_check" CHECK ("party_size" BETWEEN 1 AND 500);
ALTER TABLE "products" ADD CONSTRAINT "products_duration_check" CHECK ("duration_minutes" IS NULL OR "duration_minutes" BETWEEN 5 AND 1440);
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_price_tiers_array" CHECK (jsonb_typeof("price_tiers") = 'array');
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_settings_object" CHECK (jsonb_typeof("settings") = 'object');

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reservations USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

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
    -- Las reservas no se borran: se anulan (queda el historial)
    EXECUTE format('REVOKE DELETE ON TABLE reservations FROM %I', r.name);
    -- La empresa ajusta sus reglas de operación; la plantilla aplicada la fija la plataforma
    EXECUTE format('GRANT UPDATE (settings) ON TABLE tenants TO %I', r.name);
  END LOOP;
END $$;
