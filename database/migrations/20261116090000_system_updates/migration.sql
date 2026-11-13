-- Historial de actualizaciones (ADR 045): solo la plataforma (rol de sistema).
CREATE TYPE "SystemUpdateStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'ROLLED_BACK');

CREATE TABLE "system_updates" (
    "id" UUID NOT NULL,
    "from_version" TEXT NOT NULL,
    "to_version" TEXT NOT NULL,
    "status" "SystemUpdateStatus" NOT NULL,
    "migrations" JSONB NOT NULL DEFAULT '[]',
    "backup_path" TEXT,
    "detail" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "system_updates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "system_updates_versions_check" CHECK (length(from_version) BETWEEN 1 AND 40 AND length(to_version) BETWEEN 1 AND 40),
    CONSTRAINT "system_updates_migrations_check" CHECK (jsonb_typeof(migrations) = 'array'),
    CONSTRAINT "system_updates_dates_check" CHECK (finished_at >= started_at)
);

CREATE INDEX "system_updates_created_at_idx" ON "system_updates"("created_at");

ALTER TABLE system_updates ENABLE ROW LEVEL SECURITY;
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
    EXECUTE format('REVOKE ALL ON TABLE system_updates FROM %I', r.name);
  END LOOP;
END $$;
