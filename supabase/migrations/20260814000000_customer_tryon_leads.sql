CREATE TABLE IF NOT EXISTS customer_tryon_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  qr_id UUID REFERENCES qr_codes(id) ON DELETE SET NULL,
  tryon_id UUID REFERENCES tryons(id) ON DELETE SET NULL,
  product_id TEXT,
  customer_email TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('free', 'passcode')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_tryon_leads_email_not_blank CHECK (length(trim(customer_email)) > 3)
);

CREATE INDEX IF NOT EXISTS idx_customer_tryon_leads_brand_created
  ON customer_tryon_leads(brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_tryon_leads_email
  ON customer_tryon_leads(lower(customer_email));
