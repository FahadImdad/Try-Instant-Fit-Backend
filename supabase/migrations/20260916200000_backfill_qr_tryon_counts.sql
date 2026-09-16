-- Repair QR counters for successful try-ons recorded while
-- consume_qr_tryon was failing. Attribute a try-on to the QR for the same
-- brand/product that was active when the try-on happened. The upper bound
-- prevents a recreated QR from claiming usage belonging to a newer QR.
WITH qr_windows AS (
  SELECT
    q.id,
    q.brand_id,
    q.product_id,
    q.created_at,
    LEAD(q.created_at) OVER (
      PARTITION BY q.brand_id, q.product_id
      ORDER BY q.created_at
    ) AS next_qr_created_at
  FROM qr_codes q
), actual_counts AS (
  SELECT
    qw.id AS qr_id,
    COUNT(t.id)::INTEGER AS actual_used
  FROM qr_windows qw
  LEFT JOIN tryons t
    ON t.brand_id = qw.brand_id
   AND t.product_id = qw.product_id
   AND t.source = 'scan-wear'
   AND t.created_at >= qw.created_at
   AND (qw.next_qr_created_at IS NULL OR t.created_at < qw.next_qr_created_at)
  GROUP BY qw.id
)
UPDATE qr_codes q
SET total_used = GREATEST(COALESCE(q.total_used, 0), ac.actual_used),
    updated_at = NOW()
FROM actual_counts ac
WHERE q.id = ac.qr_id
  AND ac.actual_used > COALESCE(q.total_used, 0);
