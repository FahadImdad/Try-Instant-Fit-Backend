-- Zero-retention cleanup.
--
-- Customer try-on imagery is now ephemeral: the generated preview is returned
-- to the browser as a data: URI and never uploaded to cloud storage, and the
-- reports endpoint (which used to persist customer body photos) is disabled.
--
-- Two things are done here:
--   1. result_image_url is made nullable. The ephemeral try-on path writes
--      NULL, which the old NOT NULL constraint rejected -- silently failing
--      every customer try-on insert since the ephemeral change shipped.
--   2. Historical customer body imagery is cleared from the database so the
--      published "zero retention" guarantee is true for past users too.
--
-- Merchant garment assets (source='ghost-layer', which points at isolated
-- product images) are deliberately left intact -- those are brand-owned
-- catalog assets, not customer imagery.
--
-- NOTE: this clears the DATABASE references only. The underlying objects in
-- the GCS bucket must also be deleted -- run scripts/purge-customer-images.mjs
-- with GOOGLE_CLOUD_KEY_JSON set. Until that runs, the files remain publicly
-- reachable by direct URL even though nothing links to them.

ALTER TABLE tryons ALTER COLUMN result_image_url DROP NOT NULL;

-- Customer-facing try-on renders (body imagery).
UPDATE tryons
SET result_image_url = NULL
WHERE source = 'scan-wear'
  AND result_image_url IS NOT NULL
  AND result_image_url <> '';

-- Two early test renders logged under ghost-layer but stored in the tryons/
-- prefix (demo brand 000...001), so they are customer-shaped renders too.
UPDATE tryons
SET result_image_url = NULL
WHERE source = 'ghost-layer'
  AND result_image_url LIKE '%/tryons/%';

-- Report attachments: body photos, reported renders and user screenshots.
-- result_url is only cleared when it points at a customer render; rows that
-- reference merchant product/garment assets keep their reference.
UPDATE tryon_reports SET user_photo_url = NULL
WHERE user_photo_url IS NOT NULL;

UPDATE tryon_reports SET result_url = NULL
WHERE result_url LIKE '%/tryons/%' OR result_url LIKE '%/reports/%';

UPDATE tryon_reports SET screenshot_url = NULL
WHERE screenshot_url LIKE '%/reports/%' OR screenshot_url LIKE '%/tryons/%';
