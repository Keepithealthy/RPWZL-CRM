-- Authorization helpers (DATA_MODEL 7) and setting accessors.

-- Returns the caller's team_member id; CR401 without a session, CR402 when not on the allowlist or inactive.
-- First sign-in links team_member.user_id by the (lower-case) JWT e-mail.
create or replace function private.require_member() returns smallint
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_id    smallint;
begin
  if v_uid is null then
    perform private.raise_err('CR401', 'not_signed_in', 'no valid session');
  end if;
  select id into v_id from crm.team_member where user_id = v_uid and active;
  if v_id is null and v_email <> '' then
    -- first sign-in, or the auth user was re-created in the dashboard (old user_id no longer exists)
    update crm.team_member m set user_id = v_uid, updated_at = now()
    where m.email = v_email and m.active
      and (m.user_id is null or not exists (select 1 from auth.users u where u.id = m.user_id))
    returning m.id into v_id;
  end if;
  if v_id is null then
    perform private.raise_err('CR402', 'not_a_member', 'signed-in account is not on the active allowlist');
  end if;
  update crm.team_member set last_seen_at = now()
  where id = v_id and (last_seen_at is null or last_seen_at < now() - interval '10 minutes');
  return v_id;
end $$;

create or replace function private.require_owner() returns smallint
language plpgsql security definer set search_path = '' as $$
declare v_id smallint := private.require_member();
begin
  if not exists (select 1 from crm.team_member where id = v_id and role = 'owner') then
    perform private.raise_err('CR403', 'owner_only', 'this operation is restricted to the owner role');
  end if;
  return v_id;
end $$;

create or replace function private.is_owner(p_member smallint) returns boolean
language sql stable set search_path = '' as
$$ select exists (select 1 from crm.team_member where id = p_member and role = 'owner') $$;

-- Warsaw calendar date (database time zone is UTC).
create or replace function private.today() returns date
language sql stable set search_path = '' as $$ select (now() at time zone 'Europe/Warsaw')::date $$;

create or replace function private.default_status() returns smallint
language sql stable set search_path = '' as $$ select id from crm.lead_status where is_default $$;

create or replace function private.setting_int(p_key text, p_default int) returns int
language sql stable set search_path = '' as
$$ select coalesce((select (value #>> '{}')::int from crm.app_setting where key = p_key), p_default) $$;

create or replace function private.min_conf() returns int
language sql stable set search_path = '' as $$ select private.setting_int('val.minConfidence', 50) $$;

-- Latest applied import (report date drives wpisRel; id drives 'last' filters).
create or replace function private.latest_run() returns int
language sql stable set search_path = '' as
$$ select id from crm.import_run where status = 'applied' order by id desc limit 1 $$;

create or replace function private.latest_report_date() returns date
language sql stable set search_path = '' as
$$ select report_date from crm.import_run where status = 'applied' order by id desc limit 1 $$;

-- Bit mask of QFLAG bits that make the derived validation status 'do_sprawdzenia' (contract.ts QFLAG_PROBLEM_MASK):
-- NIP_BAD_FORMAT 2 | NIP_PLACEHOLDER 4 | NIP_CHECKSUM 8 | NO_CONTACT 16 | EMAIL_INVALID 32 | EMAIL_TYPO 64 |
-- PHONE_UNPARSEABLE 1024 | REG_DUPLICATE 65536 | ACCOUNT_CHECK 524288
create or replace function private.qflag_problem_mask() returns int
language sql immutable parallel safe set search_path = '' as $$ select 590974 $$;

select private.apply_api_grants();
