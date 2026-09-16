alter table brands
  add column if not exists tryon_model_override text;

comment on column brands.tryon_model_override is
  'Temporary per-brand try-on engine override for quality testing. NULL = default engine. Only value currently honoured: ''alt''.';

alter table brands
  drop constraint if exists brands_tryon_model_override_check;

alter table brands
  add constraint brands_tryon_model_override_check
  check (tryon_model_override is null or tryon_model_override in ('alt'));;
