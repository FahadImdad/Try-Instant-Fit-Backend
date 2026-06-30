-- Catalog browsing: let shoppers browse a brand's whole product range from the
-- scan screen and try on any item the brand chooses to show.
--
-- Three new columns, all additive and backward-compatible:
--
--   products.category         — vendor-chosen category (free text; the dashboard
--                               offers a fixed list + an "Other" free-text box).
--                               Nullable: existing products have no category and
--                               surface under "Other / Uncategorised" in filters.
--
--   products.show_in_catalog  — per-product visibility switch for the public
--                               browse grid. Default TRUE so every existing
--                               product is browsable unless the vendor hides it.
--                               A product only appears in the public catalog when
--                               it is active AND show_in_catalog AND its brand has
--                               catalog_enabled (see below).
--
--   products.buy_url          — optional vendor "Buy Now" link. When set, the
--                               scan/try-on page shows a Buy Now button that opens
--                               this URL (the vendor's own product/checkout page)
--                               in a new tab. Nullable: products without a link
--                               simply show no Buy Now button.
--
--   brands.catalog_enabled    — brand-level master switch for the "More from
--                               {Brand}" browse experience on the scan page.
--                               Default TRUE so the feature is on out of the box;
--                               a brand can turn the whole catalog off from
--                               their dashboard without touching individual
--                               products.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS only adds each column when missing, so
-- this is safe to re-run.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category        TEXT,
  ADD COLUMN IF NOT EXISTS show_in_catalog BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS buy_url         TEXT;

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS catalog_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Speeds up the public catalog query: "active, catalog-visible products for a
-- brand, newest first". Partial index keeps it small (only browsable rows).
CREATE INDEX IF NOT EXISTS idx_products_brand_catalog
  ON products (brand_id, created_at DESC)
  WHERE active = TRUE AND show_in_catalog = TRUE;
