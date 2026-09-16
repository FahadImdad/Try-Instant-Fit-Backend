-- Persist the relationships used by product and passcode analytics.
ALTER TABLE tryons
  ADD COLUMN IF NOT EXISTS product_uuid UUID REFERENCES products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS brand_passcode_id UUID REFERENCES brand_passcodes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tryons_product_uuid
  ON tryons(product_uuid);

CREATE INDEX IF NOT EXISTS idx_tryons_brand_passcode_id
  ON tryons(brand_passcode_id);

-- Repair historical relationships where the SKU or completed QR scan gives
-- us an unambiguous product/passcode link.
UPDATE tryons t
SET product_uuid = p.id
FROM products p
WHERE t.product_uuid IS NULL
  AND p.brand_id = t.brand_id
  AND p.sku = t.product_id;

UPDATE tryons t
SET brand_passcode_id = s.brand_passcode_id,
    product_uuid = COALESCE(t.product_uuid, q.product_uuid)
FROM qr_scans s
LEFT JOIN qr_codes q ON q.id = s.qr_id
WHERE s.tryon_id = t.id
  AND (t.brand_passcode_id IS NULL OR t.product_uuid IS NULL);

-- Reconcile passcode counters from their linked successful try-ons.
UPDATE brand_passcodes p
SET used_count = counts.used_count,
    updated_at = NOW()
FROM (
  SELECT brand_passcode_id, COUNT(*)::INTEGER AS used_count
  FROM tryons
  WHERE brand_passcode_id IS NOT NULL
  GROUP BY brand_passcode_id
) counts
WHERE p.id = counts.brand_passcode_id
  AND p.used_count IS DISTINCT FROM counts.used_count;
