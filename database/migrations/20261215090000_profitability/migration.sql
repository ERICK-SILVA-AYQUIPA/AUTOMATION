-- Rentabilidad por instalación (ADR 055): costos que el sistema no mide solo,
-- presupuestos mensuales y alertas de consumo. Solo para el equipo de la plataforma.

CREATE TABLE "tenant_cost_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "cycle" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "tenant_cost_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_cost_items_category_check" CHECK ("category" IN ('SERVER', 'AI', 'WHATSAPP', 'STORAGE', 'EXTERNAL', 'SUPPORT')),
    CONSTRAINT "tenant_cost_items_cycle_check" CHECK ("cycle" IN ('MONTHLY', 'ONE_TIME')),
    CONSTRAINT "tenant_cost_items_amount_check" CHECK ("amount" >= 0),
    CONSTRAINT "tenant_cost_items_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "tenant_cost_items_dates_check" CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on"),
    CONSTRAINT "tenant_cost_items_description_check" CHECK (length(btrim("description")) BETWEEN 2 AND 200)
);
CREATE INDEX "tenant_cost_items_tenant_id_idx" ON "tenant_cost_items"("tenant_id");
ALTER TABLE "tenant_cost_items" ADD CONSTRAINT "tenant_cost_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_cost_items" ADD CONSTRAINT "tenant_cost_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "tenant_budgets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "threshold_pct" INTEGER NOT NULL DEFAULT 80,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "tenant_budgets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_budgets_scope_check" CHECK ("scope" IN ('AI', 'TOTAL')),
    CONSTRAINT "tenant_budgets_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "tenant_budgets_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "tenant_budgets_threshold_check" CHECK ("threshold_pct" BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX "tenant_budgets_tenant_id_scope_key" ON "tenant_budgets"("tenant_id", "scope");
ALTER TABLE "tenant_budgets" ADD CONSTRAINT "tenant_budgets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_budgets" ADD CONSTRAINT "tenant_budgets_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "budget_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "period" CHAR(7) NOT NULL,
    "level" TEXT NOT NULL,
    "spent" DECIMAL(14,4) NOT NULL,
    "budget" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "budget_alerts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_alerts_scope_check" CHECK ("scope" IN ('AI', 'TOTAL')),
    CONSTRAINT "budget_alerts_level_check" CHECK ("level" IN ('WARN', 'EXCEEDED')),
    CONSTRAINT "budget_alerts_period_check" CHECK ("period" ~ '^\d{4}-\d{2}$')
);
CREATE UNIQUE INDEX "budget_alerts_once_key" ON "budget_alerts"("tenant_id", "scope", "period", "level");
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Moneda base y tipos de cambio que define el equipo (no se inventan ni se consultan solos)
CREATE TABLE "finance_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "base_currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "rates" JSONB NOT NULL DEFAULT '{}',
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "finance_settings_singleton_check" CHECK ("id" = 1),
    CONSTRAINT "finance_settings_currency_check" CHECK ("base_currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "finance_settings_rates_check" CHECK (jsonb_typeof("rates") = 'object')
);
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Solo la plataforma (rol de sistema): las empresas no ven sus costos ni márgenes
ALTER TABLE "tenant_cost_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_budgets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "budget_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_settings" ENABLE ROW LEVEL SECURITY;
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
    FOREACH t IN ARRAY ARRAY['tenant_cost_items', 'tenant_budgets', 'budget_alerts', 'finance_settings'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r.name);
    END LOOP;
  END LOOP;
END $$;
