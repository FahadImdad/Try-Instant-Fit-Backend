-- The dashboard's "Credits remaining" editor sends the delta between the
-- current and desired remaining credits. That delta is 0 when only the label
-- or code changed, and negative when the vendor lowers the allowance, but the
-- function only accepted >= 1, so those saves failed with a 400.
--
-- Accept the full range now:
--   0        -> no-op, return the row unchanged
--   negative -> reduce use_limit, but never below used_count, so credits that
--               have already been spent stay protected
create or replace function public.add_passcode_uses(
  p_passcode_id uuid,
  p_additional_uses integer
)
returns brand_passcodes
language plpgsql
security definer
as $function$
declare
  result brand_passcodes%ROWTYPE;
  new_limit integer;
begin
  if p_additional_uses is null or p_additional_uses < -100000 or p_additional_uses > 100000 then
    raise exception 'Change must be between -100000 and 100000';
  end if;

  select * into result from brand_passcodes where id = p_passcode_id for update;
  if not found then raise exception 'Passcode not found'; end if;

  if p_additional_uses = 0 then
    return result;
  end if;

  -- Never let the lifetime limit fall below what has already been used.
  new_limit := greatest(result.use_limit + p_additional_uses, result.used_count);

  update brand_passcodes
    set use_limit = new_limit, updated_at = now()
    where id = p_passcode_id
    returning * into result;

  return result;
end;
$function$;;
