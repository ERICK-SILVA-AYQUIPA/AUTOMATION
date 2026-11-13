-- Separada de la anterior: un valor nuevo de enum no se puede usar en la
-- misma transacción que lo crea. El recordatorio de reservas escribe al
-- cliente: apagado para las empresas existentes.
INSERT INTO "automations" ("id", "tenant_id", "key", "is_enabled", "config", "version", "updated_at")
SELECT gen_random_uuid(), t."id", 'RESERVATION_REMINDER', false, '{}', 1, now()
FROM "tenants" t
ON CONFLICT ("tenant_id", "key") DO NOTHING;
