-- Try Instant Fit — Ghost Layer MVP Schema
-- Run this in your Supabase SQL editor to set up the database

-- ── Brands ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brands (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  website_url  TEXT,
  status       TEXT NOT NULL DEFAULT 'trial'
                 CHECK (status IN ('trial', 'active', 'suspended', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- ── Demo Brand (for testing) ──────────────────────────────────────────────────
INSERT INTO brands (id, name, email, website_url, status)
VALUES (
  '00000000-0000-0000-0000-000000000001'::UUID,
  'Your Brand (Demo)',
  'demo@yourbrand.com',
  'https://client-tryinstantfit.vercel.app',
  'active'
) ON CONFLICT (email) DO NOTHING;

INSERT INTO widget_configs (brand_id, button_text, button_color, button_position)
VALUES (
  '00000000-0000-0000-0000-000000000001'::UUID,
  'Try It On ✨',
  '#FF5C35',
  'bottom-right'
) ON CONFLICT (brand_id) DO NOTHING;
