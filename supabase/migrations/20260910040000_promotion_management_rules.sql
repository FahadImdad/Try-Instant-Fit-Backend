CREATE UNIQUE INDEX IF NOT EXISTS promotional_offers_name_unique
  ON promotional_offers (LOWER(name));
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_name_unique
  ON promo_codes (LOWER(name)) WHERE name IS NOT NULL;
