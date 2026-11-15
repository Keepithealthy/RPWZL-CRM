-- RPWZL CRM foundation: schemas, extension, grants model, small helpers.
-- Layout (DATA_MODEL 2): crm = tables (not exposed), private = helpers (not exposed), api = SECURITY DEFINER RPCs only.

create schema if not exists crm;
create schema if not exists private;
create schema if not exists api;

create extension if not exists unaccent with schema extensions;

revoke all on schema crm, private from public, anon, authenticated;
revoke all on schema api from public, anon;
grant usage on schema api to authenticated;

-- Functions created by this role are not executable by PUBLIC unless granted explicitly.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema crm revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema crm revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema api revoke execute on functions from public, anon;

-- Re-applied by every migration that adds api functions: only `authenticated` may call them, never `anon`.
create or replace function private.apply_api_grants() returns void
language plpgsql set search_path = '' as $$
begin
  revoke all on all functions in schema api from public, anon;
  grant execute on all functions in schema api to authenticated;
  revoke all on all functions in schema private from public, anon, authenticated;
  revoke all on all tables in schema crm from public, anon, authenticated;
  revoke all on all sequences in schema crm from public, anon, authenticated;
end $$;

-- Raise a contract error (CONTRACT 2): errcode CR4xx, message = snake_case key, detail = English detail.
create or replace function private.raise_err(p_code text, p_msg text, p_detail text default null)
returns void language plpgsql set search_path = '' as $$
begin
  -- a null detail (e.g. 'entry ' || null for a null id) would itself fail with 22004; SEC-10
  raise exception using errcode = p_code, message = coalesce(p_msg, 'error'), detail = coalesce(p_detail, '');
end $$;

-- Case/diacritics-insensitive matching helper (Polish names: ł, ó, ą ...).
create or replace function private.f_unaccent(p_text text) returns text
language sql immutable parallel safe set search_path = '' as
$$ select extensions.unaccent('extensions.unaccent'::regdictionary, p_text) $$;

-- Polish collation for name sorting; falls back to C when ICU is unavailable (the migration records which).
do $$
begin
  begin
    create collation crm.pl_ci (provider = icu, locale = 'pl-PL');
  exception when others then
    create collation crm.pl_ci (provider = libc, locale = 'C');
  end;
end $$;

-- int64 key hash <-> 16 lower-case hex digits of the unsigned value (CONTRACT 2).
create or replace function private.hex16(p_hash bigint) returns text
language sql immutable parallel safe set search_path = '' as $$ select lpad(to_hex(p_hash), 16, '0') $$;

create or replace function private.hash_from_hex(p_hex text) returns bigint
language plpgsql immutable parallel safe set search_path = '' as $$
begin
  if p_hex is null or p_hex !~ '^[0-9a-f]{16}$' then
    perform private.raise_err('CR422', 'invalid_payload', 'key hash must be 16 lower-case hex digits: ' || coalesce(left(p_hex, 40), 'null'));
  end if;
  return ('x' || p_hex)::bit(64)::bigint;
end $$;

-- Decimal int64 string -> bigint (hashes travel as decimal strings).
create or replace function private.int64_from_text(p_text text) returns bigint
language plpgsql immutable parallel safe set search_path = '' as $$
begin
  if p_text is null or p_text !~ '^-?[0-9]{1,19}$' then
    perform private.raise_err('CR422', 'invalid_payload', 'not an int64: ' || coalesce(left(p_text, 40), 'null'));
  end if;
  return p_text::bigint;
exception when numeric_value_out_of_range then
  perform private.raise_err('CR422', 'invalid_payload', 'int64 out of range: ' || left(p_text, 40));
  return null;
end $$;

-- First 8 bytes of SHA-256(register key) as signed int64 (identity of a register entry, CONTRACT 6.2).
create or replace function private.key_hash_of(p_reg_key text) returns bigint
language sql immutable parallel safe set search_path = '' as $$
  select ('x' || encode(substring(sha256(convert_to(p_reg_key, 'UTF8')) from 1 for 8), 'hex'))::bit(64)::bigint
$$;

-- Register source names in the index order (contract.ts SOURCES).
create or replace function private.src_name(p_src smallint) returns text
language sql immutable parallel safe set search_path = '' as
$$ select (array['Rpm','Rpz','Rpzg','Rpzp','Rpzpg','Rpf','Rpfg','Rpdl','Rpdlg'])[p_src + 1] $$;

create or replace function private.src_index(p_name text) returns smallint
language sql immutable parallel safe set search_path = '' as
$$ select (array_position(array['Rpm','Rpz','Rpzg','Rpzp','Rpzpg','Rpf','Rpfg','Rpdl','Rpdlg'], p_name) - 1)::smallint $$;

select private.apply_api_grants();
