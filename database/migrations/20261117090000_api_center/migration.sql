-- Centro universal de APIs (ADR 046): bóveda de credenciales por proveedor,
-- catálogo de modelos, asignación por empresa y servicio, y consumo por llamada.

CREATE TYPE "CredentialStatus" AS ENUM ('CONNECTED', 'CONNECTED_WITH_WARNINGS', 'AUTH_ERROR', 'PERMISSION_DENIED', 'UNAVAILABLE', 'INCOMPLETE', 'PENDING_AUTHORIZATION', 'DISABLED');
CREATE TYPE "AiService" AS ENUM ('ASSISTANT', 'COMMERCIAL');
CREATE TYPE "CredentialMode" AS ENUM ('MANAGED', 'OWN');
CREATE TYPE "AiProfile" AS ENUM ('ECONOMY', 'ADVANCED', 'CUSTOM');

-- tenant_id null = credencial administrada por la plataforma (asignable); con tenant_id = clave propia de esa empresa
CREATE TABLE "provider_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets_enc" TEXT NOT NULL,
    "secret_hint" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'INCOMPLETE',
    "last_error" TEXT,
    "last_checked_at" TIMESTAMPTZ(3),
    "connected_at" TIMESTAMPTZ(3),
    "rotated_at" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "monthly_token_limit" INTEGER,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "provider_credentials_provider_check" CHECK (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
    CONSTRAINT "provider_credentials_label_check" CHECK (char_length(label) BETWEEN 1 AND 80),
    CONSTRAINT "provider_credentials_hint_check" CHECK (char_length(secret_hint) BETWEEN 1 AND 40),
    CONSTRAINT "provider_credentials_limit_check" CHECK (monthly_token_limit IS NULL OR monthly_token_limit > 0)
);
CREATE INDEX "provider_credentials_tenant_id_provider_idx" ON "provider_credentials"("tenant_id", "provider");

-- Catálogo de modelos: leído del proveedor o añadido a mano por la plataforma. Precios opcionales (sin precio no hay costo)
CREATE TABLE "ai_models" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "display_name" TEXT,
    "source" TEXT NOT NULL,
    "context_window" INTEGER,
    "max_output_tokens" INTEGER,
    "input_price_per_mtok" DECIMAL(12,4),
    "output_price_per_mtok" DECIMAL(12,4),
    "price_currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_models_source_check" CHECK (source IN ('PROVIDER', 'MANUAL')),
    CONSTRAINT "ai_models_model_id_check" CHECK (char_length(model_id) BETWEEN 1 AND 120),
    CONSTRAINT "ai_models_prices_check" CHECK ((input_price_per_mtok IS NULL OR input_price_per_mtok >= 0) AND (output_price_per_mtok IS NULL OR output_price_per_mtok >= 0))
);
CREATE UNIQUE INDEX "ai_models_provider_model_id_key" ON "ai_models"("provider", "model_id");

-- Qué proveedor, credencial y modelo usa cada servicio de IA de una empresa
CREATE TABLE "ai_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "service" "AiService" NOT NULL,
    "provider" TEXT NOT NULL,
    "credential_id" UUID NOT NULL,
    "mode" "CredentialMode" NOT NULL,
    "model" TEXT,
    "profile" "AiProfile" NOT NULL DEFAULT 'ECONOMY',
    "params" JSONB NOT NULL DEFAULT '{}',
    "monthly_token_limit" INTEGER,
    "fallback_credential_id" UUID,
    "fallback_model" TEXT,
    "allow_cross_provider_fallback" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "assigned_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ai_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "ai_assignments_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "provider_credentials"("id") ON DELETE RESTRICT,
    CONSTRAINT "ai_assignments_fallback_credential_id_fkey" FOREIGN KEY ("fallback_credential_id") REFERENCES "provider_credentials"("id") ON DELETE SET NULL,
    -- Solo Gemini admite «modelo del servidor» (GEMINI_MODEL) para las claves migradas
    CONSTRAINT "ai_assignments_model_check" CHECK (model IS NOT NULL OR provider = 'gemini'),
    CONSTRAINT "ai_assignments_limit_check" CHECK (monthly_token_limit IS NULL OR monthly_token_limit > 0),
    CONSTRAINT "ai_assignments_fallback_check" CHECK ((fallback_credential_id IS NULL) = (fallback_model IS NULL))
);
CREATE UNIQUE INDEX "ai_assignments_tenant_id_service_key" ON "ai_assignments"("tenant_id", "service");
CREATE INDEX "ai_assignments_credential_id_idx" ON "ai_assignments"("credential_id");

-- Consumo por llamada (sin contenido de la conversación)
CREATE TABLE "ai_usage_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "assignment_id" UUID,
    "service" "AiService" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "credential_id" UUID,
    "mode" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(14,6),
    "cost_currency" CHAR(3),
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "latency_ms" INTEGER,
    "fallback_used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_usage_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "ai_usage_events_mode_check" CHECK (mode IN ('MANAGED', 'OWN', 'SERVER')),
    CONSTRAINT "ai_usage_events_tokens_check" CHECK (input_tokens >= 0 AND output_tokens >= 0)
);
CREATE INDEX "ai_usage_events_tenant_id_created_at_idx" ON "ai_usage_events"("tenant_id", "created_at");
CREATE INDEX "ai_usage_events_credential_id_created_at_idx" ON "ai_usage_events"("credential_id", "created_at");

-- Una credencial nunca sirve a otra empresa: la propia debe ser de la misma
-- empresa y la administrada no puede tener dueño. Se comprueba en la base,
-- además de en el código (SECURITY DEFINER: lee credenciales que la RLS oculta).
CREATE FUNCTION ai_assignment_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c record; f record;
BEGIN
  SELECT tenant_id, provider, disabled_at INTO c FROM provider_credentials WHERE id = NEW.credential_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'credencial inexistente' USING ERRCODE = '23503'; END IF;
  IF c.provider <> NEW.provider THEN RAISE EXCEPTION 'la credencial es de otro proveedor' USING ERRCODE = '23514'; END IF;
  IF NEW.mode = 'OWN' AND c.tenant_id IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'la clave propia pertenece a otra empresa' USING ERRCODE = '42501'; END IF;
  IF NEW.mode = 'MANAGED' AND c.tenant_id IS NOT NULL THEN RAISE EXCEPTION 'una credencial administrada no puede ser de una empresa' USING ERRCODE = '42501'; END IF;
  IF c.disabled_at IS NOT NULL AND NEW.is_active THEN RAISE EXCEPTION 'la credencial está desconectada' USING ERRCODE = '23514'; END IF;
  IF NEW.fallback_credential_id IS NOT NULL THEN
    SELECT tenant_id, provider INTO f FROM provider_credentials WHERE id = NEW.fallback_credential_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'credencial de respaldo inexistente' USING ERRCODE = '23503'; END IF;
    IF f.tenant_id IS DISTINCT FROM c.tenant_id THEN RAISE EXCEPTION 'el respaldo debe tener el mismo dueño que la credencial principal' USING ERRCODE = '42501'; END IF;
    IF f.provider <> NEW.provider AND NOT NEW.allow_cross_provider_fallback THEN RAISE EXCEPTION 'el respaldo con otro proveedor exige autorización explícita' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_assignments_check BEFORE INSERT OR UPDATE ON ai_assignments FOR EACH ROW EXECUTE FUNCTION ai_assignment_check();

-- Seguridad por filas
ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON provider_credentials USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- La empresa ve sus asignaciones y solo puede escribir las de clave propia (las administradas las asigna la plataforma)
ALTER TABLE ai_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON ai_assignments FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_insert ON ai_assignments FOR INSERT WITH CHECK (tenant_id = app_current_tenant() AND mode = 'OWN');
CREATE POLICY tenant_update ON ai_assignments FOR UPDATE USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant() AND mode = 'OWN');
CREATE POLICY tenant_delete ON ai_assignments FOR DELETE USING (tenant_id = app_current_tenant() AND mode = 'OWN');

ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON ai_usage_events FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_insert ON ai_usage_events FOR INSERT WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE ai_models ENABLE ROW LEVEL SECURITY;

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
    EXECUTE format('REVOKE ALL ON TABLE ai_models FROM %I', r.name);
    EXECUTE format('REVOKE UPDATE, DELETE ON TABLE ai_usage_events FROM %I', r.name);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION ai_assignment_check() FROM %I', r.name);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION ai_assignment_check() FROM PUBLIC;

-- Las claves propias de Gemini ya guardadas pasan a la bóveda sin descifrarse
-- (mismo cifrado). El modelo queda en null = el del servidor (GEMINI_MODEL).
INSERT INTO provider_credentials (id, tenant_id, provider, label, config, secrets_enc, secret_hint, status, last_error, last_checked_at, connected_at, updated_at)
SELECT gen_random_uuid(), ti.tenant_id, 'gemini', 'Clave propia de Gemini', '{}'::jsonb, ti.secrets_enc,
       COALESCE(NULLIF(ti.config->>'hint', ''), '…'),
       CASE ti.status WHEN 'CONNECTED' THEN 'CONNECTED'::"CredentialStatus" WHEN 'ERROR' THEN 'AUTH_ERROR'::"CredentialStatus" ELSE 'INCOMPLETE'::"CredentialStatus" END,
       ti.last_error, ti.last_checked_at, CASE WHEN ti.status = 'CONNECTED' THEN COALESCE(ti.last_checked_at, ti.updated_at) END, CURRENT_TIMESTAMP
FROM tenant_integrations ti
WHERE ti.type = 'GEMINI' AND ti.secrets_enc IS NOT NULL;

INSERT INTO ai_assignments (id, tenant_id, service, provider, credential_id, mode, model, profile, updated_at)
SELECT gen_random_uuid(), pc.tenant_id, 'ASSISTANT', 'gemini', pc.id, 'OWN', NULL, 'ECONOMY', CURRENT_TIMESTAMP
FROM provider_credentials pc WHERE pc.provider = 'gemini' AND pc.tenant_id IS NOT NULL;

DELETE FROM tenant_integrations WHERE type = 'GEMINI';
