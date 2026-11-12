-- Cobro manual (ADR 036): pagos registrados por el administrador general.

CREATE TYPE "PaymentMethod" AS ENUM ('YAPE', 'PLIN', 'BANK_TRANSFER', 'CASH', 'OTHER');

CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "months" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "paid_at" TIMESTAMPTZ(3) NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "recorded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payments_amount_nonnegative" CHECK ("amount" >= 0),
    CONSTRAINT "payments_months_range" CHECK ("months" BETWEEN 1 AND 24),
    CONSTRAINT "payments_period_order" CHECK ("period_end" > "period_start")
);

CREATE INDEX "payments_tenant_id_created_at_idx" ON "payments"("tenant_id", "created_at");

ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- La empresa solo ve sus pagos y no puede crearlos, cambiarlos ni borrarlos.
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON payments FOR SELECT USING (tenant_id = app_current_tenant());

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
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE payments FROM %I', r.name);
  END LOOP;
END $$;
