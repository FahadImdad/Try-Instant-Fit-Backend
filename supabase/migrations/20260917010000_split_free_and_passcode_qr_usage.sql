-- Keep a QR's free/open allowance separate from passcode-authorized usage.
ALTER TABLE public.qr_codes
  ADD COLUMN IF NOT EXISTS free_used_count INTEGER NOT NULL DEFAULT 0;

-- Rebuild historical free usage from completed scan records. Passcode scans
-- intentionally do not consume the free/open allowance.
UPDATE public.qr_codes AS q
SET free_used_count = counts.free_count
FROM (
  SELECT qr_id, COUNT(*)::INTEGER AS free_count
  FROM public.qr_scans
  WHERE status = 'completed' AND brand_passcode_id IS NULL
  GROUP BY qr_id
) AS counts
WHERE counts.qr_id = q.id;

CREATE OR REPLACE FUNCTION public.consume_qr_tryon(
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
  q public.qr_codes%ROWTYPE;
  p public.brand_passcodes%ROWTYPE;
  next_total INTEGER;
  next_free INTEGER;
BEGIN
  SELECT qc.* INTO q FROM public.qr_codes AS qc WHERE qc.id = p_qr_id FOR UPDATE;
  IF NOT FOUND OR q.active = FALSE THEN RAISE EXCEPTION 'QR is unavailable'; END IF;
  IF q.expires_at IS NOT NULL AND q.expires_at < NOW() THEN RAISE EXCEPTION 'QR has expired'; END IF;

  IF q.requires_passcode THEN
    IF p_passcode_id IS NULL THEN RAISE EXCEPTION 'Passcode is required'; END IF;
    SELECT bp.* INTO p
    FROM public.brand_passcodes AS bp
    WHERE bp.id = p_passcode_id AND bp.brand_id = q.brand_id
    FOR UPDATE;
    IF NOT FOUND OR p.active = FALSE THEN RAISE EXCEPTION 'Passcode is unavailable'; END IF;
    IF p.expires_at IS NOT NULL AND p.expires_at < NOW() THEN RAISE EXCEPTION 'Passcode has expired'; END IF;
    IF p.used_count >= p.use_limit THEN RAISE EXCEPTION 'Passcode limit reached'; END IF;
    UPDATE public.brand_passcodes AS bp
    SET used_count = bp.used_count + 1, updated_at = NOW()
    WHERE bp.id = p.id RETURNING bp.used_count INTO p.used_count;
  ELSE
    IF q.total_limit IS NULL OR q.free_used_count >= q.total_limit THEN
      UPDATE public.qr_codes SET requires_passcode = TRUE, updated_at = NOW() WHERE id = q.id;
      RAISE EXCEPTION 'Open try-on limit reached';
    END IF;
  END IF;

  next_total := q.total_used + 1;
  next_free := q.free_used_count + CASE WHEN p_passcode_id IS NULL THEN 1 ELSE 0 END;
  UPDATE public.qr_codes AS qc
  SET total_used = next_total,
      free_used_count = next_free,
      requires_passcode = CASE
        WHEN p_passcode_id IS NULL AND qc.requires_passcode = FALSE
          AND qc.total_limit IS NOT NULL AND next_free >= qc.total_limit
        THEN TRUE ELSE qc.requires_passcode END,
      updated_at = NOW()
  WHERE qc.id = q.id
  RETURNING qc.total_used, qc.total_limit, qc.requires_passcode
  INTO q.total_used, q.total_limit, q.requires_passcode;

  RETURN QUERY SELECT q.total_used, q.total_limit, q.requires_passcode,
    CASE WHEN p_passcode_id IS NULL THEN NULL ELSE p.used_count END,
    CASE WHEN p_passcode_id IS NULL THEN NULL ELSE p.use_limit END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.consume_qr_tryon(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_qr_tryon(UUID, UUID) TO service_role;
