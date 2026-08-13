-- Add user_photo_url to tryon_reports.
--
-- When a customer flags a bad try-on, we now save THEIR input photo
-- alongside the result image so admin / AI ops can compare before vs.
-- after and tune the model. Existing rows have no photo (the input was
-- never persisted before) — that's fine, the column is nullable.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS only adds it when missing.

ALTER TABLE tryon_reports
  ADD COLUMN IF NOT EXISTS user_photo_url TEXT;
