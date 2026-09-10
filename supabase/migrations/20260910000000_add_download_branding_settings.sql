-- Per-brand control for Try Instant Fit branding on downloaded try-on images.
ALTER TABLE widget_configs
  ADD COLUMN IF NOT EXISTS show_platform_logo BOOLEAN NOT NULL DEFAULT TRUE;
