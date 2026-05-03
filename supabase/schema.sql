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
