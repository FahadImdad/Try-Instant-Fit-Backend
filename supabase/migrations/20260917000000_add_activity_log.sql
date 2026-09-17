-- Per-brand activity log: a durable record of what happened on an account.
--
-- Most of this history is reconstructible from the domain tables (a product
-- row implies it was added, a tryon row implies a try-on), and the vendor view
-- merges those in. What is NOT reconstructible is change over time: a QR's
-- requires_passcode holds only its current value, so a switch from free to
-- passcode leaves no trace once it has happened. This table records those
-- transitions as they occur.

create table if not exists activity_log (
  id         uuid primary key default gen_random_uuid(),
  brand_id   uuid not null references brands(id) on delete cascade,
  -- Machine-readable verb, e.g. 'product.created', 'qr.access_changed'.
  action     text not null,
  -- What it happened to, for grouping and linking: 'product' | 'qr' |
  -- 'passcode' | 'credits' | 'tryon' | 'report' | 'brand'.
  entity     text not null,
  entity_id  text,
  -- Human-readable summary, written at the time so it survives later renames
  -- or deletions of the thing it describes.
  summary    text not null,
  -- Structured extras: before/after values, counts, amounts.
  detail     jsonb not null default '{}'::jsonb,
  -- Who caused it: the vendor, an admin, or a customer scanning a QR.
  actor      text not null default 'brand'
             check (actor in ('brand', 'admin', 'customer', 'system')),
  created_at timestamptz not null default now()
);

create index if not exists activity_log_brand_time_idx
  on activity_log (brand_id, created_at desc);
create index if not exists activity_log_entity_idx
  on activity_log (brand_id, entity);

alter table activity_log enable row level security;

comment on table activity_log is
  'Audit trail of account activity, shown in the vendor dashboard Profile tab.';
comment on column activity_log.summary is
  'Human-readable text written at the time, so it survives later edits to the referenced entity.';
