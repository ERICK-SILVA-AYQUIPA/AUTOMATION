-- Cotizaciones, contratación y pagos de NUESTRO negocio (ADR 049). Solo el rol de
-- sistema usa estas tablas (RLS activo sin políticas, sin permisos de ejecución).

CREATE TYPE "CatalogItemKind" AS ENUM ('PLAN', 'USERS', 'MODULE', 'SETUP', 'SERVER', 'INTEGRATION', 'SERVICE', 'SUPPORT', 'MAINTENANCE', 'OTHER');
CREATE TYPE "BillingCycle" AS ENUM ('ONE_TIME', 'MONTHLY');
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "InitialPayment" AS ENUM ('ONE_TIME', 'ONE_TIME_AND_FIRST_MONTH');
CREATE TYPE "PaymentOrderStatus" AS ENUM ('PENDING', 'PROOF_SUBMITTED', 'PAID', 'CANCELLED');
CREATE TYPE "InstallationOrderStatus" AS ENUM ('AUTHORIZED', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- Datos del emisor e impuestos para cotizaciones (los escribe la plataforma)
ALTER TABLE "commercial_settings"
  ADD COLUMN "legal_name" TEXT,
  ADD COLUMN "tax_id" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "tax_name" TEXT,
  ADD COLUMN "tax_rate" DECIMAL(5,2),
  ADD COLUMN "prices_include_tax" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quote_validity_days" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "quote_terms" TEXT,
  ADD CONSTRAINT "commercial_settings_tax_check" CHECK (("tax_name" IS NULL) = ("tax_rate" IS NULL) AND ("tax_rate" IS NULL OR ("tax_rate" > 0 AND "tax_rate" < 100))),
  ADD CONSTRAINT "commercial_settings_validity_check" CHECK ("quote_validity_days" BETWEEN 1 AND 180);

-- Catálogo comercial con precios (lo que se cotiza)
CREATE TABLE "commercial_items" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "CatalogItemKind" NOT NULL,
    "billing" "BillingCycle" NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "unit" TEXT,
    "plan_code" "PlanCode",
    "module" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "commercial_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commercial_items_price_check" CHECK ("unit_price" >= 0)
);
CREATE UNIQUE INDEX "commercial_items_code_key" ON "commercial_items"("code");

-- Versiones del contrato (solo se agregan)
CREATE TABLE "contract_versions" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contract_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "contract_versions_version_key" ON "contract_versions"("version");

CREATE TABLE "sales_quotes" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "lead_id" UUID NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "country" CHAR(2),
    "plan_code" "PlanCode",
    "users" INTEGER,
    "modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deployment_mode" "DeploymentMode",
    "server_resources" TEXT,
    "initial_setup" TEXT,
    "integrations" TEXT,
    "support" TEXT,
    "maintenance" TEXT,
    "notes" TEXT,
    "initial_payment" "InitialPayment" NOT NULL DEFAULT 'ONE_TIME_AND_FIRST_MONTH',
    "subtotal_one_time" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "subtotal_monthly" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_name" TEXT,
    "tax_rate" DECIMAL(5,2),
    "prices_include_tax" BOOLEAN NOT NULL DEFAULT false,
    "tax_one_time" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_monthly" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_one_time" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_monthly" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "terms" TEXT,
    "valid_until" DATE,
    "contract_version_id" UUID,
    "issuer" JSONB,
    "client" JSONB,
    "access_token_hash" CHAR(64),
    "sent_at" TIMESTAMPTZ(3),
    "sent_by_id" UUID,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_name" TEXT,
    "accepted_document" TEXT,
    "accepted_email" TEXT,
    "accepted_ip" TEXT,
    "accepted_user_agent" TEXT,
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "sales_quotes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_quotes_sent_check" CHECK ("status" = 'DRAFT' OR ("sent_at" IS NOT NULL AND "contract_version_id" IS NOT NULL AND "valid_until" IS NOT NULL AND "terms" IS NOT NULL AND "issuer" IS NOT NULL AND "client" IS NOT NULL)),
    CONSTRAINT "sales_quotes_accepted_check" CHECK ("status" <> 'ACCEPTED' OR ("accepted_at" IS NOT NULL AND "accepted_name" IS NOT NULL)),
    CONSTRAINT "sales_quotes_amounts_check" CHECK ("subtotal_one_time" >= 0 AND "subtotal_monthly" >= 0 AND "total_one_time" >= 0 AND "total_monthly" >= 0 AND ("users" IS NULL OR "users" > 0))
);
CREATE UNIQUE INDEX "sales_quotes_number_key" ON "sales_quotes"("number");
CREATE INDEX "sales_quotes_lead_id_idx" ON "sales_quotes"("lead_id");
CREATE INDEX "sales_quotes_status_idx" ON "sales_quotes"("status");

CREATE TABLE "sales_quote_lines" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "item_id" UUID,
    "kind" "CatalogItemKind" NOT NULL,
    "billing" "BillingCycle" NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "sales_quote_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_quote_lines_check" CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "total" = round("quantity" * "unit_price", 2))
);
CREATE INDEX "sales_quote_lines_quote_id_idx" ON "sales_quote_lines"("quote_id");

-- Métodos de pago configurables por país y moneda (instrucciones escritas por la plataforma)
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL,
    "kind" "PaymentMethod" NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_payment_orders" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "lead_id" UUID NOT NULL,
    "quote_id" UUID,
    "concept" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "country" CHAR(2),
    "status" "PaymentOrderStatus" NOT NULL DEFAULT 'PENDING',
    -- Métodos permitidos para este cliente (vacío = los activos de su país y moneda)
    "allowed_method_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "access_token_hash" CHAR(64),
    "proof" JSONB,
    "proof_submitted_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "method" "PaymentMethod",
    "reference" TEXT,
    "validated_by_id" UUID,
    "validated_at" TIMESTAMPTZ(3),
    "gateway_provider" TEXT,
    "gateway_payment_id" TEXT,
    "cancel_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "sales_payment_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_payment_orders_amount_check" CHECK ("amount" > 0),
    -- Pagado solo con validación administrativa o confirmación de una pasarela oficial
    CONSTRAINT "sales_payment_orders_paid_check" CHECK ("status" <> 'PAID' OR ("paid_at" IS NOT NULL AND "validated_at" IS NOT NULL AND ("validated_by_id" IS NOT NULL OR "gateway_payment_id" IS NOT NULL)))
);
CREATE UNIQUE INDEX "sales_payment_orders_number_key" ON "sales_payment_orders"("number");
CREATE INDEX "sales_payment_orders_lead_id_idx" ON "sales_payment_orders"("lead_id");
CREATE INDEX "sales_payment_orders_status_idx" ON "sales_payment_orders"("status");
-- Una sola orden vigente por cotización (evita cobrar dos veces)
CREATE UNIQUE INDEX "sales_payment_orders_quote_open_key" ON "sales_payment_orders"("quote_id") WHERE "status" <> 'CANCELLED';
CREATE UNIQUE INDEX "sales_payment_orders_gateway_key" ON "sales_payment_orders"("gateway_provider", "gateway_payment_id");

CREATE TABLE "sales_payment_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_payment_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sales_payment_events_order_id_idx" ON "sales_payment_events"("order_id", "created_at");

-- Eventos de pasarela ya procesados (idempotencia)
CREATE TABLE "payment_gateway_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "order_id" UUID,
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_gateway_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_gateway_events_provider_event_id_key" ON "payment_gateway_events"("provider", "event_id");

-- Libro de ingresos (solo se agregan asientos)
CREATE TABLE "accounting_entries" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "entry_date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "lead_id" UUID,
    "payment_order_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "gross" DECIMAL(12,2) NOT NULL,
    "tax" DECIMAL(12,2) NOT NULL,
    "net" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod",
    "reference" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "accounting_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_entries_amounts_check" CHECK ("gross" > 0 AND "tax" >= 0 AND "net" = "gross" - "tax")
);
CREATE UNIQUE INDEX "accounting_entries_number_key" ON "accounting_entries"("number");
CREATE UNIQUE INDEX "accounting_entries_payment_order_id_key" ON "accounting_entries"("payment_order_id");

-- Orden de instalación: nace solo de un pago validado (autorización comercial)
CREATE TABLE "installation_orders" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "lead_id" UUID NOT NULL,
    "quote_id" UUID,
    "payment_order_id" UUID NOT NULL,
    "status" "InstallationOrderStatus" NOT NULL DEFAULT 'AUTHORIZED',
    "deployment_mode" "DeploymentMode",
    "plan_code" "PlanCode",
    "users" INTEGER,
    "modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "server_resources" TEXT,
    "notes" TEXT,
    "tenant_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "installation_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "installation_orders_number_key" ON "installation_orders"("number");
CREATE UNIQUE INDEX "installation_orders_payment_order_id_key" ON "installation_orders"("payment_order_id");
CREATE INDEX "installation_orders_lead_id_idx" ON "installation_orders"("lead_id");

ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "sales_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_contract_version_id_fkey" FOREIGN KEY ("contract_version_id") REFERENCES "contract_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_quote_lines" ADD CONSTRAINT "sales_quote_lines_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "sales_quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_quote_lines" ADD CONSTRAINT "sales_quote_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "commercial_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_payment_orders" ADD CONSTRAINT "sales_payment_orders_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "sales_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_payment_orders" ADD CONSTRAINT "sales_payment_orders_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "sales_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_payment_events" ADD CONSTRAINT "sales_payment_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_entries" ADD CONSTRAINT "accounting_entries_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "sales_payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_entries" ADD CONSTRAINT "accounting_entries_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "sales_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "installation_orders" ADD CONSTRAINT "installation_orders_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "sales_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "installation_orders" ADD CONSTRAINT "installation_orders_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "sales_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "installation_orders" ADD CONSTRAINT "installation_orders_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "sales_payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "installation_orders" ADD CONSTRAINT "installation_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Registros que no se cambian ni se borran: contratos, eventos de pago y asientos
CREATE FUNCTION commercial_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% no se puede modificar ni borrar', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
CREATE TRIGGER contract_versions_append_only BEFORE UPDATE OR DELETE ON "contract_versions" FOR EACH ROW EXECUTE FUNCTION commercial_append_only();
CREATE TRIGGER sales_payment_events_append_only BEFORE UPDATE OR DELETE ON "sales_payment_events" FOR EACH ROW EXECUTE FUNCTION commercial_append_only();
CREATE TRIGGER accounting_entries_append_only BEFORE UPDATE OR DELETE ON "accounting_entries" FOR EACH ROW EXECUTE FUNCTION commercial_append_only();

-- Una cotización enviada no cambia su contenido: solo su estado y los datos de aceptación o rechazo
CREATE FUNCTION sales_quote_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'una cotización enviada no se puede borrar' USING ERRCODE = '42501'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (
    NEW.lead_id, NEW.currency, NEW.country, NEW.plan_code, NEW.users, NEW.modules, NEW.deployment_mode, NEW.server_resources, NEW.initial_setup,
    NEW.integrations, NEW.support, NEW.maintenance, NEW.notes, NEW.initial_payment, NEW.subtotal_one_time, NEW.subtotal_monthly, NEW.tax_name,
    NEW.tax_rate, NEW.prices_include_tax, NEW.tax_one_time, NEW.tax_monthly, NEW.total_one_time, NEW.total_monthly, NEW.terms, NEW.valid_until,
    NEW.contract_version_id, NEW.issuer, NEW.client, NEW.sent_at
  ) IS DISTINCT FROM (
    OLD.lead_id, OLD.currency, OLD.country, OLD.plan_code, OLD.users, OLD.modules, OLD.deployment_mode, OLD.server_resources, OLD.initial_setup,
    OLD.integrations, OLD.support, OLD.maintenance, OLD.notes, OLD.initial_payment, OLD.subtotal_one_time, OLD.subtotal_monthly, OLD.tax_name,
    OLD.tax_rate, OLD.prices_include_tax, OLD.tax_one_time, OLD.tax_monthly, OLD.total_one_time, OLD.total_monthly, OLD.terms, OLD.valid_until,
    OLD.contract_version_id, OLD.issuer, OLD.client, OLD.sent_at
  ) THEN
    RAISE EXCEPTION 'una cotización enviada no se puede modificar: crea una nueva' USING ERRCODE = '42501';
  END IF;
  -- Aceptada, rechazada, vencida o anulada es definitiva
  IF OLD.status IN ('ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'la cotización ya está cerrada' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'ACCEPTED' AND (NEW.accepted_at, NEW.accepted_name, NEW.accepted_document, NEW.accepted_email, NEW.accepted_ip, NEW.accepted_user_agent)
     IS DISTINCT FROM (OLD.accepted_at, OLD.accepted_name, OLD.accepted_document, OLD.accepted_email, OLD.accepted_ip, OLD.accepted_user_agent) THEN
    RAISE EXCEPTION 'la aceptación registrada no se puede cambiar' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_quote_frozen BEFORE UPDATE OR DELETE ON "sales_quotes" FOR EACH ROW EXECUTE FUNCTION sales_quote_frozen();

CREATE FUNCTION sales_quote_lines_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "QuoteStatus";
BEGIN
  SELECT status INTO s FROM sales_quotes WHERE id = COALESCE(NEW.quote_id, OLD.quote_id);
  -- Al borrar una cotización en borrador sus líneas se van en cascada (s es NULL)
  IF s IS NOT NULL AND s <> 'DRAFT' THEN
    RAISE EXCEPTION 'las líneas de una cotización enviada no se pueden cambiar' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER sales_quote_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON "sales_quote_lines" FOR EACH ROW EXECUTE FUNCTION sales_quote_lines_frozen();

ALTER TABLE "commercial_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_quote_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_payment_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_payment_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_gateway_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounting_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "installation_orders" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r record; t text;
BEGIN
  FOR r IN
    SELECT DISTINCT g.grantee AS name
    FROM information_schema.role_table_grants g
    JOIN pg_roles ro ON ro.rolname = g.grantee
    WHERE g.table_schema = 'public' AND g.table_name = 'users' AND g.privilege_type = 'UPDATE'
      AND g.grantee <> current_user AND NOT ro.rolsuper AND NOT ro.rolbypassrls
  LOOP
    FOREACH t IN ARRAY ARRAY['commercial_items', 'contract_versions', 'sales_quotes', 'sales_quote_lines', 'payment_methods', 'sales_payment_orders',
                             'sales_payment_events', 'payment_gateway_events', 'accounting_entries', 'installation_orders']
    LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r.name);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['sales_quotes_number_seq', 'sales_payment_orders_number_seq', 'accounting_entries_number_seq', 'installation_orders_number_seq']
    LOOP
      EXECUTE format('REVOKE ALL ON SEQUENCE %I FROM %I', t, r.name);
    END LOOP;
  END LOOP;
END $$;
