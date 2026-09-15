-- Apply a 50% launch offer to every current brand and automatically assign it
-- to brands created in the future. The offer remains admin-controllable via
-- promotional_offers.active.

DO $$
DECLARE
  default_offer_id UUID;
BEGIN
  SELECT id
    INTO default_offer_id
    FROM promotional_offers
   WHERE LOWER(name) = LOWER('Default 50% Off')
   ORDER BY created_at
   LIMIT 1;

  IF default_offer_id IS NULL THEN
    INSERT INTO promotional_offers (name, discount_percent, active)
    VALUES ('Default 50% Off', 50, TRUE)
    RETURNING id INTO default_offer_id;
  ELSE
    UPDATE promotional_offers
       SET discount_percent = 50,
           active = TRUE
     WHERE id = default_offer_id;
  END IF;

  INSERT INTO promotional_offer_brands (offer_id, brand_id)
  SELECT default_offer_id, id
    FROM brands
  ON CONFLICT (offer_id, brand_id) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION assign_default_promotional_offer_to_brand()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO promotional_offer_brands (offer_id, brand_id)
  SELECT id, NEW.id
    FROM promotional_offers
   WHERE LOWER(name) = LOWER('Default 50% Off')
     AND active = TRUE
   ORDER BY created_at
   LIMIT 1
  ON CONFLICT (offer_id, brand_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assign_default_promotional_offer_after_brand_insert ON brands;
CREATE TRIGGER assign_default_promotional_offer_after_brand_insert
AFTER INSERT ON brands
FOR EACH ROW
EXECUTE FUNCTION assign_default_promotional_offer_to_brand();
