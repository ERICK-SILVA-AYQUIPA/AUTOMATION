-- Fase 5: configuración del asistente como documento validado (borrador → prueba → publicación),
-- documentos de conocimiento y tope de consumo. Se conservan los valores actuales de cada empresa.

ALTER TABLE "ai_settings"
  ADD COLUMN "profile" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "draft" JSONB,
  ADD COLUMN "draft_updated_at" TIMESTAMPTZ(3),
  ADD COLUMN "draft_tested_at" TIMESTAMPTZ(3),
  ADD COLUMN "published_at" TIMESTAMPTZ(3),
  ADD COLUMN "published_by_id" UUID,
  ADD COLUMN "monthly_token_cap" INTEGER,
  ADD CONSTRAINT "ai_settings_monthly_token_cap_positive" CHECK ("monthly_token_cap" IS NULL OR "monthly_token_cap" > 0);

-- Lo que cada empresa ya había configurado pasa a su configuración publicada
UPDATE "ai_settings" SET
  "profile" = jsonb_build_object(
    'assistantName', "assistant_name",
    'tone', "tone",
    'welcomeMessage', COALESCE("welcome_message", ''),
    'businessInfo', COALESCE("business_info", ''),
    'handoffKeywords', to_jsonb("handoff_keywords")
  ),
  "published_at" = "updated_at";

ALTER TABLE "ai_settings"
  DROP COLUMN "assistant_name",
  DROP COLUMN "tone",
  DROP COLUMN "welcome_message",
  DROP COLUMN "business_info",
  DROP COLUMN "handoff_keywords";

CREATE TABLE "ai_knowledge_docs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "published_title" TEXT,
    "published_content" TEXT,
    "pending_delete" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ai_knowledge_docs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_knowledge_docs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "ai_knowledge_docs_title_length" CHECK (char_length("title") BETWEEN 1 AND 120),
    CONSTRAINT "ai_knowledge_docs_content_length" CHECK (char_length("content") BETWEEN 1 AND 20000)
);
CREATE INDEX "ai_knowledge_docs_tenant_id_idx" ON "ai_knowledge_docs"("tenant_id");

ALTER TABLE ai_knowledge_docs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_knowledge_docs USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
