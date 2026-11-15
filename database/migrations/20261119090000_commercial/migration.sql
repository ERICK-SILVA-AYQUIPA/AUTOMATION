-- Página comercial y agente comercial (ADR 048). Información de NUESTRO negocio:
-- solo el rol de sistema la usa (RLS activo sin políticas, sin permisos de ejecución).

CREATE TYPE "SalesChatRole" AS ENUM ('VISITOR', 'AGENT');

-- Consentimiento del prospecto para que lo contactemos después
ALTER TABLE "sales_leads" ADD COLUMN "follow_up_consent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sales_leads" ADD COLUMN "follow_up_consent_at" TIMESTAMPTZ(3);
ALTER TABLE "sales_leads" ADD COLUMN "follow_up_consent_source" TEXT;

-- Configuración de la página comercial y del agente (una sola fila)
CREATE TABLE "commercial_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "headline" TEXT,
    "subheadline" TEXT,
    "problems" JSONB NOT NULL DEFAULT '[]',
    "benefits" JSONB NOT NULL DEFAULT '[]',
    "faqs" JSONB NOT NULL DEFAULT '[]',
    "testimonials" JSONB NOT NULL DEFAULT '[]',
    "contact_email" TEXT,
    "contact_whatsapp" TEXT,
    "show_prices" BOOLEAN NOT NULL DEFAULT false,
    "chat_enabled" BOOLEAN NOT NULL DEFAULT false,
    "agent_name" TEXT,
    "agent_instructions" TEXT,
    -- Empresa interna cuyo WhatsApp y asignación de IA (servicio COMMERCIAL) usa el agente comercial
    "house_tenant_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "commercial_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commercial_settings_single_row" CHECK ("id" = 1),
    CONSTRAINT "commercial_settings_publish_check" CHECK (NOT "published" OR "headline" IS NOT NULL)
);
ALTER TABLE "commercial_settings" ADD CONSTRAINT "commercial_settings_house_tenant_id_fkey" FOREIGN KEY ("house_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
INSERT INTO "commercial_settings" ("id") VALUES (1);

-- Conversaciones del chat de la página comercial
CREATE TABLE "sales_chat_sessions" (
    "id" UUID NOT NULL,
    -- SHA-256 del token que guarda el navegador del visitante
    "token_hash" CHAR(64) NOT NULL,
    "lead_id" UUID,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "handoff_reason" TEXT,
    "handoff_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_chat_sessions_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "sales_chat_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" "SalesChatRole" NOT NULL,
    "text" TEXT NOT NULL,
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_chat_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sales_chat_sessions_lead_id_idx" ON "sales_chat_sessions"("lead_id");
CREATE INDEX "sales_chat_messages_session_id_created_at_idx" ON "sales_chat_messages"("session_id", "created_at");
ALTER TABLE "sales_chat_sessions" ADD CONSTRAINT "sales_chat_sessions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "sales_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_chat_messages" ADD CONSTRAINT "sales_chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sales_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "commercial_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_chat_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_chat_messages" ENABLE ROW LEVEL SECURITY;

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
    EXECUTE format('REVOKE ALL ON TABLE commercial_settings FROM %I', r.name);
    EXECUTE format('REVOKE ALL ON TABLE sales_chat_sessions FROM %I', r.name);
    EXECUTE format('REVOKE ALL ON TABLE sales_chat_messages FROM %I', r.name);
  END LOOP;
END $$;
