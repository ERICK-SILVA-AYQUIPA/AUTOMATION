-- FASE 5: espejo de conversaciones en Chatwoot

ALTER TABLE "customers" ADD COLUMN "chatwoot_contact_id" INTEGER,
ADD COLUMN "chatwoot_source_id" TEXT;

ALTER TABLE "messages" ADD COLUMN "chatwoot_message_id" INTEGER;

ALTER TABLE "tenant_integrations" ADD COLUMN "webhook_key" TEXT;

ALTER TABLE "users" ADD COLUMN "chatwoot_user_id" INTEGER;

CREATE UNIQUE INDEX "messages_tenant_id_chatwoot_message_id_key" ON "messages"("tenant_id", "chatwoot_message_id");

CREATE UNIQUE INDEX "tenant_integrations_webhook_key_key" ON "tenant_integrations"("webhook_key");
