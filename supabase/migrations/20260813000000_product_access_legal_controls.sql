-- Vendor product availability, private-by-default catalog controls, versioned
-- registration consent, and atomic QR/passcode usage accounting.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS available_sizes TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS custom_size_available BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS custom_size_note TEXT;

-- Only affects future inserts. Existing vendor choices remain unchanged.
ALTER TABLE products ALTER COLUMN show_in_catalog SET DEFAULT FALSE;

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terms_version TEXT,
  ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS privacy_version TEXT;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_available_sizes_count;
ALTER TABLE products ADD CONSTRAINT products_available_sizes_count
  CHECK (cardinality(available_sizes) <= 30);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_custom_size_note_length;
ALTER TABLE products ADD CONSTRAINT products_custom_size_note_length
  CHECK (custom_size_note IS NULL OR char_length(custom_size_note) <= 240);

-- The public/open mode is always finite. A QR may have no total limit only
-- while it is passcode-protected.
UPDATE qr_codes
  SET requires_passcode = TRUE, updated_at = NOW()
  WHERE requires_passcode = FALSE AND (total_limit IS NULL OR total_limit <= 0);

ALTER TABLE qr_codes DROP CONSTRAINT IF EXISTS qr_open_access_requires_limit;
ALTER TABLE qr_codes ADD CONSTRAINT qr_open_access_requires_limit
  CHECK (requires_passcode = TRUE OR (total_limit IS NOT NULL AND total_limit > 0));

CREATE OR REPLACE FUNCTION consume_qr_tryon(
  p_qr_id UUID,
  p_passcode_id UUID DEFAULT NULL
) RETURNS TABLE (
  total_used INTEGER,
  total_limit INTEGER,
  requires_passcode BOOLEAN,
  passcode_used INTEGER,
  passcode_limit INTEGER
) AS $$
DECLARE
  q qr_codes%ROWTYPE;
  p brand_passcodes%ROWTYPE;
  next_total INTEGER;
BEGIN
  SELECT * INTO q FROM qr_codes WHERE id = p_qr_id FOR UPDATE;
  IF NOT FOUND OR q.active = FALSE THEN
    RAISE EXCEPTION 'QR is unavailable';
  END IF;

  IF q.expires_at IS NOT NULL AND q.expires_at < NOW() THEN
    RAISE EXCEPTION 'QR has expired';
  END IF;

  IF q.requires_passcode THEN
    IF p_passcode_id IS NULL THEN RAISE EXCEPTION 'Passcode is required'; END IF;
    SELECT * INTO p FROM brand_passcodes
      WHERE id = p_passcode_id AND brand_id = q.brand_id FOR UPDATE;
    IF NOT FOUND OR p.active = FALSE THEN RAISE EXCEPTION 'Passcode is unavailable'; END IF;
    IF p.expires_at IS NOT NULL AND p.expires_at < NOW() THEN RAISE EXCEPTION 'Passcode has expired'; END IF;
    IF p.used_count >= p.use_limit THEN RAISE EXCEPTION 'Passcode limit reached'; END IF;
    UPDATE brand_passcodes
      SET used_count = used_count + 1, updated_at = NOW()
      WHERE id = p.id
      RETURNING used_count INTO p.used_count;
  ELSE
    IF q.total_limit IS NULL OR q.total_used >= q.total_limit THEN
      UPDATE qr_codes SET requires_passcode = TRUE, updated_at = NOW() WHERE id = q.id;
      RAISE EXCEPTION 'Open try-on limit reached';
    END IF;
  END IF;

  next_total := q.total_used + 1;
  UPDATE qr_codes
    SET total_used = next_total,
        requires_passcode = CASE
          WHEN requires_passcode = FALSE AND total_limit IS NOT NULL AND next_total >= total_limit THEN TRUE
          ELSE requires_passcode
        END,
        updated_at = NOW()
    WHERE id = q.id
    RETURNING qr_codes.total_used, qr_codes.total_limit, qr_codes.requires_passcode
      INTO q.total_used, q.total_limit, q.requires_passcode;

  RETURN QUERY SELECT q.total_used, q.total_limit, q.requires_passcode,
    CASE WHEN p_passcode_id IS NULL THEN NULL ELSE p.used_count END,
    CASE WHEN p_passcode_id IS NULL THEN NULL ELSE p.use_limit END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION add_passcode_uses(
  p_passcode_id UUID,
  p_additional_uses INTEGER
) RETURNS brand_passcodes AS $$
DECLARE
  result brand_passcodes%ROWTYPE;
BEGIN
  IF p_additional_uses IS NULL OR p_additional_uses < 1 OR p_additional_uses > 100000 THEN
    RAISE EXCEPTION 'Additional uses must be between 1 and 100000';
  END IF;

  UPDATE brand_passcodes
    SET use_limit = use_limit + p_additional_uses, updated_at = NOW()
    WHERE id = p_passcode_id
    RETURNING * INTO result;
  IF NOT FOUND THEN RAISE EXCEPTION 'Passcode not found'; END IF;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
