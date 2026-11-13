-- Fase 3 de la evolución: alta de empresas desde la plataforma (ADR 039).
-- ONBOARDING: la empresa existe y su equipo puede configurarla, pero el
-- asistente no responde a clientes hasta que la plataforma la activa.
ALTER TYPE "TenantStatus" ADD VALUE IF NOT EXISTS 'ONBOARDING';

ALTER TABLE "tenants" ADD COLUMN "activated_at" TIMESTAMPTZ(3),
ADD COLUMN "provisioning_key" UUID;

CREATE UNIQUE INDEX "tenants_provisioning_key_key" ON "tenants"("provisioning_key");

-- Las empresas existentes ya están en marcha desde su alta
UPDATE "tenants" SET "activated_at" = "created_at" WHERE "activated_at" IS NULL;

-- Solo la plataforma (rol de sistema) escribe estas columnas: el rol de
-- ejecución mantiene únicamente sus permisos por columna sobre el perfil.
