-- Keep the current offer for currently assigned brands, but stop silently
-- assigning it to future brands. All offers remain admin-controlled.
UPDATE promotional_offers
   SET name = 'Limited Time Promotion Offer - Flat 50% OFF'
 WHERE LOWER(name) = LOWER('Default 50% Off');

DROP TRIGGER IF EXISTS assign_default_promotional_offer_after_brand_insert ON brands;
DROP FUNCTION IF EXISTS assign_default_promotional_offer_to_brand();
