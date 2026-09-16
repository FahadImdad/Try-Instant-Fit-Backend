-- Per-brand try-on engine override (temporary, for quality testing).
--
-- NULL = the default locked engine. Every existing brand stays on it; this
-- column changes nothing until a row is explicitly opted in.
--
-- Deliberately not named after any provider in the schema, matching the
-- convention in the try-on route: the AI engine is never named publicly.

alter table brands
  add column if not exists tryon_model_override text;

comment on column brands.tryon_model_override is
  'Temporary per-brand try-on engine override for quality testing. NULL = default engine. Only value currently honoured: ''alt''.';

-- Guard against typos silently falling back to the default: only NULL or the
-- one known value are accepted.
alter table brands
  drop constraint if exists brands_tryon_model_override_check;

alter table brands
  add constraint brands_tryon_model_override_check
  check (tryon_model_override is null or tryon_model_override in ('alt'));
