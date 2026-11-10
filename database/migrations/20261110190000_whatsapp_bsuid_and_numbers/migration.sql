-- FASE 4: identificación de clientes por BSUID de WhatsApp y credenciales por número.

-- Clientes: el teléfono puede faltar (usuarios con nombre de usuario); se identifica por BSUID
ALTER TABLE "customers" ADD COLUMN "wa_profile_name" TEXT,
ADD COLUMN "wa_user_id" TEXT,
ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_or_wa_user_id"
  CHECK ("phone" IS NOT NULL OR "wa_user_id" IS NOT NULL);
CREATE UNIQUE INDEX "customers_tenant_id_wa_user_id_key" ON "customers"("tenant_id", "wa_user_id");

-- Mensajes: estado de entrega y error del proveedor
ALTER TABLE "messages" ADD COLUMN "error_code" INTEGER,
ADD COLUMN "error_message" TEXT,
ADD COLUMN "outbound_id" UUID,
ADD COLUMN "provider_timestamp" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "messages_outbound_id_key" ON "messages"("outbound_id");

ALTER TABLE "outbound_messages" ADD COLUMN "error_code" INTEGER;

-- Números de WhatsApp: URL de webhook propia y secretos cifrados
ALTER TABLE "whatsapp_numbers" ADD COLUMN "app_secret_enc" TEXT,
ADD COLUMN "evolution_api_key_enc" TEXT,
ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "label" TEXT,
ADD COLUMN "last_webhook_at" TIMESTAMPTZ(3),
ADD COLUMN "verify_token_enc" TEXT,
ADD COLUMN "webhook_key" TEXT;
UPDATE "whatsapp_numbers" SET "webhook_key" = encode(gen_random_bytes(24), 'hex') WHERE "webhook_key" IS NULL;
ALTER TABLE "whatsapp_numbers" ALTER COLUMN "webhook_key" SET NOT NULL;
CREATE UNIQUE INDEX "whatsapp_numbers_webhook_key_key" ON "whatsapp_numbers"("webhook_key");
