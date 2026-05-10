-- Try Instant Fit — Ghost Layer MVP Schema
-- Run this in your Supabase SQL editor to set up the database

-- ── Brands ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brands (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  email                 TEXT NOT NULL UNIQUE,
  website_url           TEXT,
  status                TEXT NOT NULL DEFAULT 'trial'
                          CHECK (status IN ('trial', 'active', 'suspended', 'cancelled')),
  -- Per-brand credit / quota system (added 2026-05)
  tryon_credits         INTEGER NOT NULL DEFAULT 0,
  tryon_credits_used    INTEGER NOT NULL DEFAULT 0,
  price_per_tryon_usd   NUMERIC(8,4) NOT NULL DEFAULT 0.125,  -- 8 try-ons per $1 default
  unlimited             BOOLEAN NOT NULL DEFAULT FALSE,        -- partner / demo brands
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Brand Credit Top-Ups (audit log) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brand_credit_topups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  credits_added INTEGER NOT NULL CHECK (credits_added > 0),
  amount_usd    NUMERIC(10,2),
  payment_ref   TEXT,
  notes         TEXT,
  added_by      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_brand_credit_topups_brand_id ON brand_credit_topups(brand_id);
CREATE INDEX IF NOT EXISTS idx_brand_credit_topups_created_at ON brand_credit_topups(created_at DESC);

-- ── Widget Configs ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS widget_configs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  button_text      TEXT NOT NULL DEFAULT 'Try It On ✨',
  button_color     TEXT NOT NULL DEFAULT '#1a1a2e',
  button_position  TEXT NOT NULL DEFAULT 'bottom-right'
                     CHECK (button_position IN ('top-right','bottom-right','top-left','bottom-left')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (brand_id)
);

-- ── Try-Ons ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tryons (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id            UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  product_id          TEXT,
  product_name        TEXT,
  result_image_url    TEXT NOT NULL,
  ai_model            TEXT NOT NULL,
  processing_time_ms  INTEGER,
  cost_usd            NUMERIC(10, 4),
  source              TEXT NOT NULL DEFAULT 'ghost-layer'
                        CHECK (source IN ('ghost-layer','scan-wear','digital-mirror')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Analytics Events ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  event_name  TEXT NOT NULL,
  event_data  JSONB NOT NULL DEFAULT '{}',
  page_url    TEXT,
  product     TEXT NOT NULL DEFAULT 'ghost-layer',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Product Garments (AI cache) ─────────────────────────────────────────────
-- Cache of pre-processed (background-removed) garment images, keyed by brand+product.
-- product_garments.brand_id is TEXT (legacy) and holds UUID-format strings; not FK-enforced.
CREATE TABLE IF NOT EXISTS product_garments (
  product_id            TEXT NOT NULL,
  brand_id              TEXT NOT NULL,
  isolated_garment_url  TEXT NOT NULL,
  mime_type             TEXT NOT NULL DEFAULT 'image/jpeg',
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (product_id, brand_id)
);

-- ── Scan & Wear: QR Codes ──────────────────────────────────────────────────
-- One QR per product, with optional passcode-gating for anti-abuse.
CREATE TABLE IF NOT EXISTS qr_codes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token              TEXT NOT NULL UNIQUE,                             -- short URL-safe scan token
  brand_id           UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  product_id         TEXT NOT NULL,                                    -- soft-link to product_garments.product_id
  product_name       TEXT NOT NULL,                                    -- display name for customer-facing scan page
  display_image_url  TEXT,                                             -- optional product image to show on scan page
  requires_passcode  BOOLEAN NOT NULL DEFAULT FALSE,
  total_limit        INTEGER,                                          -- optional QR-level cap (NULL = unlimited)
  total_used         INTEGER NOT NULL DEFAULT 0,
  expires_at         TIMESTAMPTZ,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (total_limit IS NULL OR total_limit >= 0),
  CHECK (total_used >= 0)
);
CREATE INDEX IF NOT EXISTS idx_qr_codes_brand_id ON qr_codes(brand_id);
CREATE INDEX IF NOT EXISTS idx_qr_codes_token ON qr_codes(token);
CREATE INDEX IF NOT EXISTS idx_qr_codes_active ON qr_codes(active) WHERE active = TRUE;

-- ── Scan & Wear: Passcodes (per-customer try-limits) ───────────────────────
-- Brand creates codes like "SARAH50" with a use_limit, hands out to specific customers.
CREATE TABLE IF NOT EXISTS qr_passcodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_id           UUID NOT NULL REFERENCES qr_codes(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,                                       -- the passcode itself, e.g. "SARAH50"
  customer_label  TEXT,                                                -- optional: who's it for, "Sarah K"
  use_limit       INTEGER NOT NULL,
  used_count      INTEGER NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (qr_id, code),
  CHECK (use_limit > 0),
  CHECK (used_count >= 0 AND used_count <= use_limit)
);
CREATE INDEX IF NOT EXISTS idx_qr_passcodes_qr_id ON qr_passcodes(qr_id);
CREATE INDEX IF NOT EXISTS idx_qr_passcodes_code ON qr_passcodes(code);
CREATE INDEX IF NOT EXISTS idx_qr_passcodes_active ON qr_passcodes(active) WHERE active = TRUE;

-- ── Scan & Wear: Scans (analytics + abuse tracking) ────────────────────────
-- Every QR scan attempt — successful or not. Used for analytics and rate-limiting.
CREATE TABLE IF NOT EXISTS qr_scans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_id         UUID NOT NULL REFERENCES qr_codes(id) ON DELETE CASCADE,
  passcode_id   UUID REFERENCES qr_passcodes(id) ON DELETE SET NULL,
  tryon_id      UUID REFERENCES tryons(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'started'
                  CHECK (status IN ('started','code_invalid','code_expired','limit_reached','completed','abandoned','error')),
  user_agent    TEXT,
  ip_hashed     TEXT,
  scanned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_qr_scans_qr_id ON qr_scans(qr_id);
CREATE INDEX IF NOT EXISTS idx_qr_scans_passcode_id ON qr_scans(passcode_id);
CREATE INDEX IF NOT EXISTS idx_qr_scans_scanned_at ON qr_scans(scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_qr_scans_status ON qr_scans(status);

-- ── Contact Submissions ─────────────────────────────────────────────────────
-- Captures leads from the marketing site contact form before they become brands.
CREATE TABLE IF NOT EXISTS contact_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,
  brand_name        TEXT NOT NULL,
  website_url       TEXT,
  product_interest  TEXT
                      CHECK (product_interest IN ('ghost-layer','scan-wear','digital-mirror','multiple','not-sure') OR product_interest IS NULL),
  message           TEXT,
  status            TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','contacted','qualified','converted','rejected')),
  source            TEXT NOT NULL DEFAULT 'website'
                      CHECK (source IN ('website','whatsapp','email','referral')),
  brand_id          UUID REFERENCES brands(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tryons_brand_id ON tryons(brand_id);
CREATE INDEX IF NOT EXISTS idx_tryons_created_at ON tryons(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_brand_id ON analytics_events(brand_id);
CREATE INDEX IF NOT EXISTS idx_analytics_event_name ON analytics_events(event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_created_at ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_email ON contact_submissions(email);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_status ON contact_submissions(status);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_created_at ON contact_submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_garments_brand_id ON product_garments(brand_id);

-- ── Try-On Reports / Feedback ─────────────────────────────────────────────────
-- Captures customer + brand reports of bad try-ons, bad image-processing, or
-- general feedback. An approved 'tryon_bad' or 'image_bad' report refunds
-- 1 credit to the brand via refund_credit_for_report() below.
--
-- product_id is TEXT (not UUID FK) to match the existing soft-link pattern
-- on tryons.product_id and qr_codes.product_id — keeps cross-table joins
-- simple and lets the customer scan flow submit the same product_id it
-- already works with.
CREATE TABLE IF NOT EXISTS tryon_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        UUID REFERENCES brands(id) ON DELETE SET NULL,
  tryon_id        UUID REFERENCES tryons(id) ON DELETE SET NULL,
  product_id      TEXT,                                       -- soft-link, SKU-style
  qr_id           UUID REFERENCES qr_codes(id) ON DELETE SET NULL,
  -- 'tryon_bad'      → bad virtual try-on result (eligible for refund)
  -- 'image_bad'      → garment-isolation / image-processing produced a bad asset (eligible for refund)
  -- 'feedback'       → general feedback (👍 / 👎 / free text), no refund
  -- 'difficulty'     → user reports a platform difficulty (any page), no refund
  type            TEXT NOT NULL CHECK (type IN ('tryon_bad','image_bad','feedback','difficulty')),
  rating          SMALLINT CHECK (rating BETWEEN -1 AND 5),  -- -1=👎, 0=neutral, 1=👍, or 1–5 stars
  reason          TEXT,                                       -- short reason code or label
  message         TEXT,                                       -- free-text user note
  screenshot_url  TEXT,                                       -- optional uploaded screenshot
  result_url      TEXT,                                       -- the try-on image being reported (if any)
  user_photo_url  TEXT,                                       -- customer's input photo (saved on report only — for admin/AI review)
  source          TEXT NOT NULL DEFAULT 'customer'
                    CHECK (source IN ('customer','brand','admin')),
  -- Admin review state
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','denied','closed')),
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  -- Refund tracking (set by refund_credit_for_report() on approval)
  credit_refunded BOOLEAN NOT NULL DEFAULT FALSE,
  refund_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tryon_reports_brand_id    ON tryon_reports(brand_id);
CREATE INDEX IF NOT EXISTS idx_tryon_reports_status      ON tryon_reports(status);
CREATE INDEX IF NOT EXISTS idx_tryon_reports_created_at  ON tryon_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tryon_reports_type        ON tryon_reports(type);

-- ── Credit Ledger (deep analytics: try-on vs image-processing splits) ────────
-- One row per credit-consuming event. Pricing is uniform: $0.125 per credit
-- regardless of kind. Used for per-brand breakdowns on the dashboard +
-- admin panel; the brands.tryon_credits / tryon_credits_used aggregate
-- counters remain the source of truth for live balances.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  product_id      TEXT,                                       -- soft-link, SKU-style
  qr_id           UUID REFERENCES qr_codes(id) ON DELETE SET NULL,
  tryon_id        UUID REFERENCES tryons(id) ON DELETE SET NULL,
  -- 'tryon'      → 1 credit deducted for a customer try-on
  -- 'process'    → 1 credit deducted for image processing (garment isolation)
  -- 'refund'     → 1 credit returned (approved 'tryon_bad' / 'image_bad' report)
  -- 'topup'      → admin/manual top-up (mirrors brand_credit_topups for unification)
  kind            TEXT NOT NULL CHECK (kind IN ('tryon','process','refund','topup')),
  amount          INTEGER NOT NULL,                 -- positive = consumed, negative = refunded back
  cost_usd        NUMERIC(10,4),                    -- $ value (defaults to brand's price_per_tryon_usd × amount)
  report_id       UUID REFERENCES tryon_reports(id) ON DELETE SET NULL,  -- set on refund rows
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_brand_id    ON credit_ledger(brand_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_kind        ON credit_ledger(kind);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_created_at  ON credit_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_brand_kind  ON credit_ledger(brand_id, kind);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_report_id   ON credit_ledger(report_id);

-- ── Brand credit summary view (per-brand breakdown ready for dashboard) ─────
CREATE OR REPLACE VIEW brand_credit_summary AS
SELECT
  b.id                                                          AS brand_id,
  b.name                                                        AS brand_name,
  b.tryon_credits                                               AS credits_total,
  b.tryon_credits_used                                          AS credits_used_aggregate,
  GREATEST(b.tryon_credits - b.tryon_credits_used, 0)           AS credits_remaining,
  b.price_per_tryon_usd                                         AS price_per_credit_usd,
  COALESCE(SUM(CASE WHEN cl.kind = 'tryon'   THEN cl.amount END), 0) AS tryon_count,
  COALESCE(SUM(CASE WHEN cl.kind = 'process' THEN cl.amount END), 0) AS process_count,
  COALESCE(SUM(CASE WHEN cl.kind = 'refund'  THEN ABS(cl.amount) END), 0) AS refund_count,
  COALESCE(SUM(CASE WHEN cl.kind = 'topup'   THEN cl.amount END), 0) AS topup_count,
  ROUND(COALESCE(SUM(CASE WHEN cl.kind = 'tryon'   THEN cl.amount END), 0) * b.price_per_tryon_usd, 4) AS tryon_spend_usd,
  ROUND(COALESCE(SUM(CASE WHEN cl.kind = 'process' THEN cl.amount END), 0) * b.price_per_tryon_usd, 4) AS process_spend_usd,
  ROUND(COALESCE(SUM(CASE WHEN cl.kind = 'refund'  THEN ABS(cl.amount) END), 0) * b.price_per_tryon_usd, 4) AS refund_value_usd
FROM brands b
LEFT JOIN credit_ledger cl ON cl.brand_id = b.id
GROUP BY b.id, b.name, b.tryon_credits, b.tryon_credits_used, b.price_per_tryon_usd;

-- ── Atomic refund function (admin approve → 1 credit back) ──
-- Locks the report, refunds 1 credit (decrements tryon_credits_used),
-- writes a credit_ledger row of kind='refund', and marks the report
-- approved + credit_refunded — all in one transaction.
CREATE OR REPLACE FUNCTION refund_credit_for_report(
  p_report_id     UUID,
  p_resolved_by   TEXT,
  p_resolution    TEXT DEFAULT NULL
) RETURNS TABLE (
  report_id        UUID,
  brand_id         UUID,
  credits_refunded INTEGER,
  refund_at        TIMESTAMPTZ
) AS $$
DECLARE
  r        tryon_reports%ROWTYPE;
  v_price  NUMERIC(10,4);
BEGIN
  SELECT * INTO r FROM tryon_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND                          THEN RAISE EXCEPTION 'Report % not found', p_report_id; END IF;
  IF r.status <> 'pending'              THEN RAISE EXCEPTION 'Report % already resolved (status=%)', p_report_id, r.status; END IF;
  IF r.type NOT IN ('tryon_bad','image_bad') THEN RAISE EXCEPTION 'Report % type % is not eligible for refund', p_report_id, r.type; END IF;
  IF r.brand_id IS NULL                 THEN RAISE EXCEPTION 'Report % has no brand_id — cannot refund', p_report_id; END IF;

  UPDATE brands
  SET    tryon_credits_used = GREATEST(tryon_credits_used - 1, 0),
         updated_at         = NOW()
  WHERE  id = r.brand_id
  RETURNING price_per_tryon_usd INTO v_price;

  INSERT INTO credit_ledger (brand_id, product_id, qr_id, tryon_id, kind, amount, cost_usd, report_id, notes)
  VALUES (r.brand_id, r.product_id, r.qr_id, r.tryon_id,
          'refund', -1, -COALESCE(v_price, 0.125),
          r.id, CONCAT('Refund for report (', r.type, ')'));

  UPDATE tryon_reports
  SET    status          = 'approved',
         credit_refunded = TRUE,
         refund_at       = NOW(),
         resolved_by     = p_resolved_by,
         resolved_at     = NOW(),
         resolution_note = p_resolution
  WHERE  id = p_report_id;

  RETURN QUERY SELECT r.id, r.brand_id, 1::INTEGER, NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Demo Brand (for testing) ──────────────────────────────────────────────────
INSERT INTO brands (id, name, email, website_url, status, unlimited)
VALUES (
  '00000000-0000-0000-0000-000000000001'::UUID,
  'Your Brand (Demo)',
  'demo@yourbrand.com',
  'https://client-tryinstantfit.vercel.app',
  'active',
  TRUE  -- demo brand has no quota
) ON CONFLICT (email) DO NOTHING;

INSERT INTO widget_configs (brand_id, button_text, button_color, button_position)
VALUES (
  '00000000-0000-0000-0000-000000000001'::UUID,
  'Try It On ✨',
  '#FF5C35',
  'bottom-right'
) ON CONFLICT (brand_id) DO NOTHING;
