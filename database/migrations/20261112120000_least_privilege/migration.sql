-- Mínimo privilegio para los roles de la aplicación (auditoría de lanzamiento).
-- RLS ya aísla las empresas; esto añade una segunda barrera por si una consulta
-- o una inyección intentara escribir donde el código nunca escribe.
--
-- Los nombres de los roles dependen de .env, así que se localizan por sus
-- permisos: todo rol (distinto del propietario) con UPDATE sobre "users".
--   * sin BYPASSRLS  → rol de ejecución (peticiones de las empresas)
--   * con BYPASSRLS  → rol de sistema (login, registro, webhooks, plataforma)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT g.grantee AS name, ro.rolbypassrls AS bypass
    FROM information_schema.role_table_grants g
    JOIN pg_roles ro ON ro.rolname = g.grantee
    WHERE g.table_schema = 'public' AND g.table_name = 'users' AND g.privilege_type = 'UPDATE'
      AND g.grantee <> current_user AND NOT ro.rolsuper
  LOOP
    -- Nadie salvo el propietario toca el historial de migraciones
    EXECUTE format('REVOKE ALL ON TABLE _prisma_migrations FROM %I', r.name);

    IF NOT r.bypass THEN
      -- Planes y suscripciones: solo lectura (los cambia la plataforma, rol de sistema)
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE plans, subscriptions FROM %I', r.name);
      -- La empresa puede editar su nombre, moneda y zona horaria; nunca su estado
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE tenants FROM %I', r.name);
      EXECUTE format('GRANT UPDATE (name, currency, timezone, updated_at) ON TABLE tenants TO %I', r.name);
      -- Tokens de correo y eventos crudos de webhooks: solo el rol de sistema
      EXECUTE format('REVOKE ALL ON TABLE auth_tokens, inbound_events FROM %I', r.name);
      -- Libros de solo anexar: nunca se modifican ni se borran
      EXECUTE format('REVOKE UPDATE, DELETE ON TABLE audit_logs, inventory_movements, order_status_history, product_history FROM %I', r.name);
    END IF;
  END LOOP;
END $$;
