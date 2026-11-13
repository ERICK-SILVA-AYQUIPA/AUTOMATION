-- Fase 2 de la plataforma: perfil de empresa, modalidad y módulos; etiquetas y notas internas de conversación.

CREATE TYPE "BusinessType" AS ENUM ('RETAIL', 'RESTAURANT', 'DISTRIBUTOR', 'SERVICES', 'PHARMACY', 'OTHER');
CREATE TYPE "DeploymentMode" AS ENUM ('SAAS', 'DEDICATED', 'CUSTOM');

ALTER TABLE "conversations" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "tenants"
  ADD COLUMN "address" TEXT,
  ADD COLUMN "brand_color" TEXT,
  ADD COLUMN "business_type" "BusinessType" NOT NULL DEFAULT 'RETAIL',
  ADD COLUMN "contact_email" TEXT,
  ADD COLUMN "country" CHAR(2) NOT NULL DEFAULT 'PE',
  ADD COLUMN "custom_domain" TEXT,
  ADD COLUMN "deployment_mode" "DeploymentMode" NOT NULL DEFAULT 'SAAS',
  ADD COLUMN "enabled_modules" TEXT[] DEFAULT ARRAY['conversations', 'ai', 'catalog', 'inventory', 'orders', 'customers', 'reports', 'automations']::TEXT[],
  ADD COLUMN "legal_name" TEXT,
  ADD COLUMN "logo_url" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "tax_id" TEXT,
  ADD COLUMN "template_key" TEXT,
  ADD CONSTRAINT "tenants_brand_color_hex" CHECK ("brand_color" IS NULL OR "brand_color" ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT "tenants_custom_domain_format" CHECK ("custom_domain" IS NULL OR "custom_domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');

CREATE UNIQUE INDEX "tenants_custom_domain_key" ON "tenants"("custom_domain");

CREATE TABLE "conversation_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "author_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conversation_notes_body_length" CHECK (char_length("body") BETWEEN 1 AND 2000)
);
CREATE INDEX "conversation_notes_tenant_id_conversation_id_created_at_idx" ON "conversation_notes"("tenant_id", "conversation_id", "created_at");
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Notas: solo lectura y alta (historial), aisladas por empresa
ALTER TABLE conversation_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON conversation_notes FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_insert ON conversation_notes FOR INSERT WITH CHECK (tenant_id = app_current_tenant());

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
    EXECUTE format('REVOKE UPDATE, DELETE ON TABLE conversation_notes FROM %I', r.name);
    -- La empresa edita su perfil; dominio, modalidad, módulos y plantilla los fija la plataforma
    EXECUTE format('GRANT UPDATE (legal_name, tax_id, country, address, phone, contact_email, business_type, logo_url, brand_color) ON TABLE tenants TO %I', r.name);
  END LOOP;
END $$;
