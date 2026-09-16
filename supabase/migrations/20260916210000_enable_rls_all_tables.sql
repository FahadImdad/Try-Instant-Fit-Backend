-- Enable RLS on every public table that was missing it.
--
-- All of these are reached only through the API routes, which use the
-- service-role key. Service-role bypasses RLS, so the application is
-- unaffected. The point is the backstop: with RLS on and no policies, an
-- exposed anon key yields nothing instead of full read/write on every row.
--
-- Applied in two steps against production (customer_tryon_leads first, then
-- the rest), with the live endpoints verified between them.

alter table customer_tryon_leads  enable row level security;
alter table brands                enable row level security;
alter table widget_configs        enable row level security;
alter table tryons                enable row level security;
alter table analytics_events      enable row level security;
alter table product_garments      enable row level security;
alter table contact_submissions   enable row level security;
alter table qr_codes              enable row level security;
alter table qr_passcodes          enable row level security;
alter table qr_scans              enable row level security;
alter table brand_credit_topups   enable row level security;
alter table products              enable row level security;
alter table brand_passcodes       enable row level security;
alter table credit_topup_requests enable row level security;
alter table fx_rates              enable row level security;
alter table tryon_reports         enable row level security;
alter table credit_ledger         enable row level security;
