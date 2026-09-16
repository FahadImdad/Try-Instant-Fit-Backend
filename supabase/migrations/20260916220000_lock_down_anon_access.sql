-- Close the paths that row level security does not cover.
--
-- 1. SECURITY DEFINER functions bypass RLS entirely. Exposed to anon, these
--    three let a caller grant passcode uses, consume try-ons, or issue credit
--    refunds — regardless of the RLS enabled in the previous migration.
--    EXECUTE was held by PUBLIC (which anon and authenticated inherit), so
--    revoking from those roles alone has no effect; it has to come off PUBLIC.
-- 2. anon and authenticated held SELECT on every table, which also left them
--    discoverable through the exposed REST/GraphQL schema.
--
-- Nothing here affects the application: the browser never talks to PostgREST,
-- it calls the Next.js API, which uses the service-role key.

revoke execute on function public.add_passcode_uses(uuid, integer)           from public;
revoke execute on function public.consume_qr_tryon(uuid, uuid)               from public;
revoke execute on function public.refund_credit_for_report(uuid, text, text) from public;

grant execute on function public.add_passcode_uses(uuid, integer)           to service_role;
grant execute on function public.consume_qr_tryon(uuid, uuid)               to service_role;
grant execute on function public.refund_credit_for_report(uuid, text, text) to service_role;

-- Pin search_path so a function body cannot be redirected to a
-- caller-controlled schema.
alter function public.add_passcode_uses(uuid, integer)           set search_path = public, pg_temp;
alter function public.consume_qr_tryon(uuid, uuid)               set search_path = public, pg_temp;
alter function public.refund_credit_for_report(uuid, text, text) set search_path = public, pg_temp;

revoke all on all tables in schema public    from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- The view enforced its creator's permissions rather than the caller's.
alter view public.brand_credit_summary set (security_invoker = true);
