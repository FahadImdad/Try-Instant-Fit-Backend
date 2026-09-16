-- Admin -> vendor announcements.
--
-- An announcement targets either every brand ('all') or an explicit list
-- ('selected', rows in announcement_brands). Visibility is time-boxed by
-- starts_at / ends_at, mirroring promotional_offers. Each brand dismisses
-- independently, so dismissals are their own table rather than a flag.

create table if not exists announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  level      text not null default 'info'
             check (level in ('info', 'warning', 'success')),
  audience   text not null default 'all'
             check (audience in ('all', 'selected')),
  active     boolean not null default true,
  starts_at  timestamptz,
  ends_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Targeted recipients. Only consulted when audience = 'selected'.
create table if not exists announcement_brands (
  announcement_id uuid not null references announcements(id) on delete cascade,
  brand_id        uuid not null references brands(id) on delete cascade,
  primary key (announcement_id, brand_id)
);

-- One row per brand that has crossed an announcement off its banner.
create table if not exists announcement_dismissals (
  announcement_id uuid not null references announcements(id) on delete cascade,
  brand_id        uuid not null references brands(id) on delete cascade,
  dismissed_at    timestamptz not null default now(),
  primary key (announcement_id, brand_id)
);

create index if not exists announcement_brands_brand_idx
  on announcement_brands (brand_id);
create index if not exists announcement_dismissals_brand_idx
  on announcement_dismissals (brand_id);
-- Supports the vendor-side "currently live" filter.
create index if not exists announcements_live_idx
  on announcements (active, starts_at, ends_at);

-- Match promotional_offers: RLS on, no public policies. All access goes
-- through the service-role key in the API routes, never the anon key.
alter table announcements           enable row level security;
alter table announcement_brands     enable row level security;
alter table announcement_dismissals enable row level security;

comment on table announcements is
  'Admin-authored notices shown to vendors on their dashboard.';
comment on column announcements.audience is
  '''all'' = every brand; ''selected'' = the brands listed in announcement_brands.';
comment on column announcements.ends_at is
  'Optional expiry. NULL means the announcement runs until deactivated.';
