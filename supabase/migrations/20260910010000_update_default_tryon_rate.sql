-- New standard rate. Keep explicitly negotiated brand rates unchanged.
ALTER TABLE brands ALTER COLUMN price_per_tryon_usd SET DEFAULT 0.25;
UPDATE brands SET price_per_tryon_usd = 0.25 WHERE price_per_tryon_usd = 0.125;
