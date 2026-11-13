-- Separada de la anterior: un valor nuevo de enum no se puede usar en la
-- misma transacción que lo crea.

-- Las automatizaciones que hasta ahora no hacían nada (aviso de estado al
-- cliente y aviso de derivación) no se encienden solas: escriben al cliente o
-- envían correos nuevos, así que la empresa decide activarlas.
UPDATE "automations" SET "is_enabled" = false WHERE "key" IN ('ORDER_STATUS_NOTIFICATION', 'HANDOFF_NOTIFICATION');

-- El recordatorio de pedidos pendientes es nuevo: apagado para las empresas existentes
INSERT INTO "automations" ("id", "tenant_id", "key", "is_enabled", "config", "version", "updated_at")
SELECT gen_random_uuid(), t."id", 'PENDING_ORDER_REMINDER', false, '{}', 1, now()
FROM "tenants" t
ON CONFLICT ("tenant_id", "key") DO NOTHING;

-- Historial: la empresa solo puede leer sus eventos y pedir un reintento
-- (estado, intentos, próxima fecha y error). No borra ni cambia el contenido.
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
    EXECUTE format('REVOKE UPDATE, DELETE ON TABLE automation_events FROM %I', r.name);
    EXECUTE format('GRANT UPDATE (status, attempts, next_attempt_at, last_error, retried_by_id) ON TABLE automation_events TO %I', r.name);
    EXECUTE format('REVOKE DELETE ON TABLE automations FROM %I', r.name);
  END LOOP;
END $$;
