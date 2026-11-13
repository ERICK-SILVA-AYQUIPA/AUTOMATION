-- Versión y migraciones en el panel general (ADR 045): el rol de sistema puede
-- LEER el registro de migraciones; el rol de ejecución (empresas) no lo ve.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper AND rolcanlogin AND rolname <> current_user LOOP
    EXECUTE format('GRANT SELECT ON TABLE _prisma_migrations TO %I', r.rolname);
  END LOOP;
  FOR r IN
    SELECT DISTINCT g.grantee AS name
    FROM information_schema.role_table_grants g
    JOIN pg_roles ro ON ro.rolname = g.grantee
    WHERE g.table_schema = 'public' AND g.table_name = 'users' AND g.privilege_type = 'UPDATE'
      AND g.grantee <> current_user AND NOT ro.rolsuper AND NOT ro.rolbypassrls
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE _prisma_migrations FROM %I', r.name);
  END LOOP;
END $$;
