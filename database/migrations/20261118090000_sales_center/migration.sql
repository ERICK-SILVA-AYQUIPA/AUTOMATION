-- Centro comercial (ADR 047): prospectos de AI Sales Assistant y su historial.
-- Es información de NUESTRO negocio: solo el rol de sistema la lee y escribe
-- (RLS activo sin políticas y sin permisos para el rol de ejecución).

CREATE TYPE "SalesLeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'DEMO_REQUESTED', 'QUOTE_SENT', 'NEGOTIATION', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'INSTALLATION_PENDING', 'ACTIVE_CLIENT', 'LOST');
CREATE TYPE "SalesLeadSource" AS ENUM ('WEBSITE', 'WHATSAPP', 'REFERRAL', 'SOCIAL', 'EVENT', 'OUTBOUND', 'OTHER');
CREATE TYPE "SalesActivityType" AS ENUM ('CREATED', 'NOTE', 'CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'UPDATED', 'STATUS_CHANGED', 'OWNER_CHANGED', 'NEXT_ACTION_SET', 'NEXT_ACTION_DONE', 'PAYMENT_VALIDATED', 'CONVERTED', 'ACTIVATED');

CREATE TABLE "sales_leads" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "sector" TEXT,
    "need" TEXT,
    "source" "SalesLeadSource" NOT NULL,
    "source_detail" TEXT,
    "estimated_budget" DECIMAL(12,2),
    "budget_currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "interest_mode" "DeploymentMode",
    "interest_plan" TEXT,
    "interest_modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "SalesLeadStatus" NOT NULL DEFAULT 'NEW',
    "owner_id" UUID,
    "next_action" TEXT,
    "next_action_at" TIMESTAMPTZ(3),
    "lost_reason" TEXT,
    "tenant_id" UUID,
    "converted_at" TIMESTAMPTZ(3),
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_leads_pkey" PRIMARY KEY ("id"),
    -- Sin forma de contacto no hay prospecto
    CONSTRAINT "sales_leads_contact_check" CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL),
    CONSTRAINT "sales_leads_lost_reason_check" CHECK ("status" <> 'LOST' OR "lost_reason" IS NOT NULL),
    CONSTRAINT "sales_leads_budget_check" CHECK ("estimated_budget" IS NULL OR "estimated_budget" >= 0),
    -- Cliente activo e instalación pendiente solo con la empresa creada
    CONSTRAINT "sales_leads_tenant_check" CHECK ("status" NOT IN ('INSTALLATION_PENDING', 'ACTIVE_CLIENT') OR "tenant_id" IS NOT NULL)
);

CREATE TABLE "sales_activities" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "type" "SalesActivityType" NOT NULL,
    "body" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_activities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_leads_number_key" ON "sales_leads"("number");
CREATE UNIQUE INDEX "sales_leads_tenant_id_key" ON "sales_leads"("tenant_id");
CREATE INDEX "sales_leads_status_updated_at_idx" ON "sales_leads"("status", "updated_at");
CREATE INDEX "sales_leads_owner_id_idx" ON "sales_leads"("owner_id");
CREATE INDEX "sales_leads_next_action_at_idx" ON "sales_leads"("next_action_at");
-- Búsqueda de duplicados por correo y teléfono
CREATE INDEX "sales_leads_email_idx" ON "sales_leads"(lower("email"));
CREATE INDEX "sales_leads_phone_idx" ON "sales_leads"("phone");
CREATE INDEX "sales_activities_lead_id_created_at_idx" ON "sales_activities"("lead_id", "created_at");

ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "sales_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El historial solo se anexa: ni el rol de sistema puede cambiarlo o borrarlo
CREATE FUNCTION sales_activity_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'el historial comercial no se puede modificar ni borrar' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER sales_activities_append_only BEFORE UPDATE OR DELETE ON "sales_activities" FOR EACH ROW EXECUTE FUNCTION sales_activity_append_only();

-- El responsable debe ser personal de la plataforma
CREATE FUNCTION sales_lead_owner_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id AND tenant_id IS NULL AND role = 'PLATFORM_ADMIN') THEN
    RAISE EXCEPTION 'el responsable debe ser personal de la plataforma' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_leads_owner_check BEFORE INSERT OR UPDATE OF owner_id ON "sales_leads" FOR EACH ROW EXECUTE FUNCTION sales_lead_owner_check();

ALTER TABLE "sales_leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_activities" ENABLE ROW LEVEL SECURITY;

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
    EXECUTE format('REVOKE ALL ON TABLE sales_leads FROM %I', r.name);
    EXECUTE format('REVOKE ALL ON TABLE sales_activities FROM %I', r.name);
    EXECUTE format('REVOKE ALL ON SEQUENCE sales_leads_number_seq FROM %I', r.name);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION sales_activity_append_only() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sales_lead_owner_check() FROM PUBLIC;
