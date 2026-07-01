-- Two-level product categorisation: a top-level GROUP above the existing
-- category. Groups let shoppers filter the catalogue by broad style
-- (Eastern / Western / Formal / Everyday) before narrowing to a specific
-- category (Kurta, Dress, etc.).
--
-- Separate from 2026_07_01_add_catalog_browsing.sql on purpose: that file may
-- already be applied, so this ships the new column on its own and can be run
-- independently.
--
--   products.category_group — vendor-chosen top-level style group. Free text in
--                             the DB (the dashboard offers a fixed set: Eastern,
--                             Western, Formal & Festive) so it stays flexible.
--                             Nullable: existing products have no group and
--                             surface as "Other / Ungrouped" in filters.
--
--   products.audience        — who the item is for: Women / Men / Kids / Unisex.
--                             An independent filter axis from category_group (a
--                             Kurta can be Men's or Women's). Nullable: existing
--                             products show under "All" until set.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS only adds each when missing — safe to re-run.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category_group TEXT,
  ADD COLUMN IF NOT EXISTS audience       TEXT;
