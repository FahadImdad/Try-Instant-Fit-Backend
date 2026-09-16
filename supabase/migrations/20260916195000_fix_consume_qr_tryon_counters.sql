-- Fix ambiguous column references in the QR/passcode consumption function.
-- The previous function could fail after a successful AI try-on, leaving
-- qr_codes.total_used and brand_passcodes.used_count unchanged.
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
  SELECT qc.* INTO q
  FROM qr_codes AS qc
  WHERE qc.id = p_qr_id
  FOR UPDATE;

  IF NOT FOUND OR q.active = FALSE THEN
    RAISE EXCEPTION 'QR is unavailable';
  END IF;

  IF q.expires_at IS NOT NULL AND q.expires_at < NOW() THEN
    RAISE EXCEPTION 'QR has expired';
  END IF;

  IF q.requires_passcode THEN
    IF p_passcode_id IS NULL THEN
      RAISE EXCEPTION 'Passcode is required';
    END IF;

    SELECT bp.* INTO p
    FROM brand_passcodes AS bp
    WHERE bp.id = p_passcode_id
      AND bp.brand_id = q.brand_id
    FOR UPDATE;

    IF NOT FOUND OR p.active = FALSE THEN
      RAISE EXCEPTION 'Passcode is unavailable';
    END IF;
    IF p.expires_at IS NOT NULL AND p.expires_at < NOW() THEN
      RAISE EXCEPTION 'Passcode has expired';
    END IF;
    IF p.used_count >= p.use_limit THEN
      RAISE EXCEPTION 'Passcode limit reached';
    END IF;

    UPDATE brand_passcodes AS bp
    SET used_count = bp.used_count + 1,
        updated_at = NOW()
    WHERE bp.id = p.id
    RETURNING bp.used_count INTO p.used_count;
  ELSE
    IF q.total_limit IS NULL OR q.total_used >= q.total_limit THEN
      UPDATE qr_codes AS qc
      SET requires_passcode = TRUE,
          updated_at = NOW()
      WHERE qc.id = q.id;
      RAISE EXCEPTION 'Open try-on limit reached';
    END IF;
  END IF;

  next_total := q.total_used + 1;
  UPDATE qr_codes AS qc
  SET total_used = next_total,
      requires_passcode = CASE
        WHEN qc.requires_passcode = FALSE
          AND qc.total_limit IS NOT NULL
          AND next_total >= qc.total_limit
        THEN TRUE
        ELSE qc.requires_passcode
      END,
      updated_at = NOW()
  WHERE qc.id = q.id
  RETURNING qc.total_used, qc.total_limit, qc.requires_passcode
    INTO q.total_used, q.total_limit, q.requires_passcode;

  RETURN QUERY
  SELECT q.total_used,
         q.total_limit,
         q.requires_passcode,
         CASE WHEN p_passcode_id IS NULL THEN NULL ELSE p.used_count END,
         CASE WHEN p_passcode_id IS NULL THEN NULL ELSE p.use_limit END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
