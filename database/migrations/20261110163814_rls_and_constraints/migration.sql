-- =============================================================================
-- Seguridad a nivel de fila (RLS) y restricciones de integridad.
--
-- Modelo de roles:
--   propietario (migraciones)  -> no sujeto a RLS (no se usa FORCE)
--   rol de ejecución (API)     -> sujeto a RLS; ve solo filas de app.tenant_id
--   rol de sistema             -> BYPASSRLS; procesos internos acotados
-- La API fija el tenant en cada transacción con:
--   SELECT set_config('app.tenant_id', '<uuid>', true);
-- Sin ese valor, app_current_tenant() es NULL y no se ve ninguna fila.
-- =============================================================================

-- Extensiones "trusted": el propietario de la base puede instalarlas.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Tablas de negocio con aislamiento completo (lectura y escritura) por tenant_id
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'subscriptions','usage_counters','tenant_counters','branches','categories',
    'products','product_variants','product_images','stock_levels','customers',
    'orders','order_items','whatsapp_numbers','conversations','messages',
    'outbound_messages','ai_settings','automations','tenant_integrations',
    'notifications','users','sessions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

-- Tablas de solo-anexar (historial/auditoría/libro de inventario): sin UPDATE ni DELETE
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_movements','product_history','order_status_history','audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_select ON %I FOR SELECT USING (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

-- La empresa solo ve (y edita) su propia fila
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());

-- Planes: lectura pública, escritura solo del rol de sistema / propietario
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY plans_read ON plans FOR SELECT USING (true);

-- Tablas exclusivas del sistema: RLS sin políticas = denegado al rol de ejecución
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------- Integridad
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_quantity_nonzero CHECK (quantity <> 0),
  ADD CONSTRAINT inventory_movements_balance CHECK (stock_after = stock_before + quantity),
  ADD CONSTRAINT inventory_movements_negative_needs_auth CHECK (stock_after >= 0 OR allow_negative);

ALTER TABLE order_items
  ADD CONSTRAINT order_items_quantity_positive CHECK (quantity > 0),
  ADD CONSTRAINT order_items_price_nonnegative CHECK (unit_price >= 0 AND total >= 0);

ALTER TABLE orders
  ADD CONSTRAINT orders_amounts_nonnegative CHECK (subtotal >= 0 AND discount >= 0 AND total >= 0);

ALTER TABLE products
  ADD CONSTRAINT products_prices_nonnegative CHECK (sale_price >= 0 AND (cost_price IS NULL OR cost_price >= 0)),
  ADD CONSTRAINT products_min_stock_nonnegative CHECK (min_stock >= 0);

ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_prices_nonnegative CHECK ((sale_price IS NULL OR sale_price >= 0) AND (cost_price IS NULL OR cost_price >= 0));

ALTER TABLE users
  ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  ADD CONSTRAINT users_platform_admin_without_tenant CHECK ((role = 'PLATFORM_ADMIN') = (tenant_id IS NULL));

-- Una sola variante predeterminada por producto y una sola sucursal predeterminada por empresa
CREATE UNIQUE INDEX product_variants_one_default ON product_variants (product_id) WHERE is_default;
CREATE UNIQUE INDEX branches_one_default ON branches (tenant_id) WHERE is_default;

-- Búsqueda difusa de productos
CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX product_variants_name_trgm ON product_variants USING gin (name gin_trgm_ops);
