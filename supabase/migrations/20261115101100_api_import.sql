-- api: register import and monthly refresh (CONTRACT 6). Writers of register tables; they never touch CRM tables
-- except val_proposal (which is validation output, not CRM-entered data).

create or replace function private.run_json(r crm.import_run) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', r.id, 'status', r.status, 'fileName', r.file_name, 'reportDate', r.report_date,
    'startedAt', r.started_at, 'finishedAt', r.finished_at, 'startedBy', r.started_by, 'counts', r.counts, 'error', r.error)
$$;

-- The running import run, owned by the caller (CR403 otherwise); CR423 when it is not running any more.
create or replace function private.require_run(p_run int, p_me smallint) returns crm.import_run
language plpgsql set search_path = '' as $$
declare r crm.import_run;
begin
  select * into r from crm.import_run where id = p_run;
  if not found then perform private.raise_err('CR404', 'not_found', 'import run ' || p_run); end if;
  if r.started_by <> p_me then perform private.raise_err('CR403', 'owner_only', 'the import run was started by another user'); end if;
  if r.status <> 'running' then perform private.raise_err('CR423', 'import_locked', 'import run ' || p_run || ' is ' || r.status); end if;
  return r;
end $$;

-- Sorted ids of the dictionary values of the given facets among the entry's facet ids.
create or replace function private.fv_group(p_fv smallint[], p_facets text[]) returns smallint[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(d.id order by d.id), '{}'::smallint[]) from crm.reg_dict d where d.id = any (p_fv) and d.facet = any (p_facets)
$$;

create or replace function private.fv_values(p_fv smallint[], p_facets text[]) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(d.val order by d.val), '[]'::jsonb) from crm.reg_dict d where d.id = any (p_fv) and d.facet = any (p_facets)
$$;

create or replace function api.import_begin(p_meta jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me  smallint := private.require_owner();
  v_id  int;
  v_full text[];
begin
  if jsonb_typeof(p_meta) is distinct from 'object' or (p_meta ->> 'indexVersion') is distinct from '2' then
    perform private.raise_err('CR422', 'invalid_payload', 'meta.indexVersion must be 2');
  end if;
  if jsonb_typeof(p_meta -> 'sources') is distinct from 'array' or (p_meta ->> 'reportDate') is null then
    perform private.raise_err('CR422', 'invalid_payload', 'meta.sources and meta.reportDate are required');
  end if;
  if pg_database_size(current_database()) > 450 * 1024 * 1024 then
    perform private.raise_err('CR422', 'database_full', 'database above 450 MB: free space before importing');
  end if;
  update crm.import_run set status = 'failed', finished_at = now(), error = 'superseded: running for more than 2 hours'
  where status = 'running' and started_at < now() - interval '2 hours';
  select coalesce(array_agg(s ->> 'id'), '{}') into v_full from jsonb_array_elements(p_meta -> 'sources') s
  where coalesce((s ->> 'records')::int, 0) > 0;
  begin
    insert into crm.import_run (file_name, file_sha256, index_version, hash_version, index_created_at, tool_today, report_date,
                                sources, full_sources, preview, started_by)
    values (left(p_meta ->> 'fileName', 300), left(p_meta ->> 'fileSha256', 100), 2, coalesce((p_meta ->> 'hashVersion')::smallint, 1),
            (p_meta ->> 'createdAt')::timestamptz, (p_meta ->> 'today')::date, (p_meta ->> 'reportDate')::date,
            p_meta -> 'sources', v_full, p_meta -> 'preview', v_me)
    returning id into v_id;
  exception when unique_violation then
    perform private.raise_err('CR423', 'import_locked', 'another import run is in progress');
  end;
  return jsonb_build_object('runId', v_id);
end $$;

create or replace function api.import_state(p_after_id int, p_limit int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me   smallint := private.require_owner();
  v_data text;
  v_n    int;
  v_last int;
begin
  if p_limit is not null and p_limit > 20000 then perform private.raise_err('CR413', 'too_many_rows', 'limit above 20000'); end if;
  if p_limit is null or p_limit < 1 or p_after_id is null or p_after_id < 0 then
    perform private.raise_err('CR422', 'invalid_payload', 'p_after_id >= 0 and 1 <= p_limit <= 20000 required');
  end if;
  select string_agg(s.line, E'\n' order by s.id), count(*), max(s.id) into v_data, v_n, v_last from (
    select e.id,
           e.id || E'\t' || private.hex16(e.key_hash) || E'\t' || e.h_all || E'\t' || e.h_contact || E'\t' || e.h_derived || E'\t'
           || (case when e.in_register then 1 else 0 end) || E'\t' || e.src as line
    from crm.reg_entry e where e.id > p_after_id order by e.id limit p_limit) s;
  return jsonb_build_object('data', coalesce(v_data, ''), 'nextAfterId', case when v_n = p_limit then v_last end);
end $$;

-- SEC-12: the dictionary section of import_entries / import_labels re-synchronises the identity sequence; two calls of one
-- run running at the same time would hand out the same id. This transaction-scoped lock serialises that section.
create or replace function private.lock_reg_dict() returns void
language sql set search_path = '' as $$ select pg_advisory_xact_lock(7243001) $$;

-- SEC-09: why a derived object sent by the import is out of range, or null (the worker always sends valid values).
create or replace function private.bad_derived(p_derived jsonb) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_derived is null or jsonb_typeof(p_derived) is distinct from 'object' then 'derived'
    when (p_derived ->> 'entityType') is null or (p_derived ->> 'entityType') !~ '^[1-5]$' then 'derived.entityType'
    when (p_derived ->> 'nipStatus') is null or (p_derived ->> 'nipStatus') !~ '^[0-4]$' then 'derived.nipStatus'
    when (p_derived ->> 'accountSize') is null or (p_derived ->> 'accountSize') !~ '^[1-9][0-9]{0,8}$' then 'derived.accountSize'
    when (p_derived ->> 'qflags') is null or (p_derived ->> 'qflags') !~ '^[0-9]{1,10}$' or (p_derived ->> 'qflags')::bigint > 2147483647 then 'derived.qflags'
    when (p_derived ->> 'qEmail') is not null and ((p_derived ->> 'qEmail') !~ '^[0-9]{1,3}$' or (p_derived ->> 'qEmail')::int > 100) then 'derived.qEmail'
    when (p_derived ->> 'qPhone') is not null and ((p_derived ->> 'qPhone') !~ '^[0-9]{1,3}$' or (p_derived ->> 'qPhone')::int > 100) then 'derived.qPhone'
    when (p_derived ->> 'telShared') is not null and (p_derived ->> 'telShared') !~ '^[0-9]{1,9}$' then 'derived.telShared'
    when jsonb_typeof(p_derived -> 'nums') = 'array' and jsonb_array_length(p_derived -> 'nums') > 50 then 'derived.nums above 50 numbers'
    when jsonb_typeof(p_derived -> 'isAccountPrimary') is distinct from 'boolean' then 'derived.isAccountPrimary'
  end
$$;

create or replace function api.import_labels(p_run_id int, p_labels jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_owner();
  v_upd int;
  v_ins int;
begin
  perform private.require_run(p_run_id, v_me);
  if jsonb_typeof(p_labels) is distinct from 'array' then perform private.raise_err('CR422', 'invalid_payload', 'labels must be an array'); end if;
  if jsonb_array_length(p_labels) > 20000 then perform private.raise_err('CR413', 'too_many_rows', 'labels above 20000'); end if;
  -- COR-02: dropped and re-created per call, so a pooled connection never keeps the structure of an older migration
  if to_regclass('pg_temp._lab') is not null then drop table pg_temp._lab; end if;
  create temporary table _lab (facet text, val text, label text) on commit drop;
  insert into _lab select distinct on (facet, val) facet, val, label from jsonb_to_recordset(p_labels) as x(facet text, val text, label text);
  if exists (select 1 from _lab where facet is null or val is null or length(val) > 300 or length(label) > 500
             or facet not in ('p.status','p.rodzaje','p.grp','p.spec','p.dz','p.fn','p.forma','p.formType','p.woj','r.src','r.grupaPraktyk',
                              'r.gz','r.typ','r.rodzaj','r.rd','r.spec','r.zakres','r.forma','r.organ','r.status','r.woj','org')) then
    perform private.raise_err('CR422', 'invalid_payload', 'labels: unknown facet or oversized value');
  end if;
  update crm.reg_dict d set label = l.label from _lab l
  where d.facet = l.facet and d.val = l.val and d.label is distinct from l.label;
  get diagnostics v_upd = row_count;
  -- only genuinely new values are inserted (ON CONFLICT would still burn identity values); SEC-07 headroom check,
  -- SEC-13 at most 2000 new values per call (the real file brings about 800 labels in one call), SEC-12 lock
  if exists (select 1 from _lab l where not exists (select 1 from crm.reg_dict d where d.facet = l.facet and d.val = l.val)) then
    perform private.lock_reg_dict();
    if (select count(*) from _lab l where not exists (select 1 from crm.reg_dict d where d.facet = l.facet and d.val = l.val)) > 2000 then
      perform private.raise_err('CR413', 'too_many_rows', 'more than 2000 new dictionary values in one call');
    end if;
    perform setval('crm.reg_dict_id_seq', greatest((select max(d.id) from crm.reg_dict d), 1), (select count(*) > 0 from crm.reg_dict));
    if coalesce((select max(d.id) from crm.reg_dict d), 0)
       + (select count(*) from _lab l where not exists (select 1 from crm.reg_dict d where d.facet = l.facet and d.val = l.val)) > 32767 then
      perform private.raise_err('CR422', 'dictionary_full', 'the facet dictionary (32767 values) would overflow');
    end if;
  end if;
  insert into crm.reg_dict (facet, val, label)
  select l.facet, l.val, l.label from _lab l
  where not exists (select 1 from crm.reg_dict d where d.facet = l.facet and d.val = l.val)
  on conflict (facet, val) do nothing;
  get diagnostics v_ins = row_count;
  return jsonb_build_object('upserted', v_upd + v_ins);
end $$;

-- Core of import_entries (also called by seed.sql, which has no JWT). Idempotent for a repeated batch.
-- Why an account key sent by the import is not acceptable, or null. The key must have the shape the validation produces
-- ('n:<NIP>' or 'e:<16 hex>') and must agree with the team's stored attach / detach decision for that entry, so an old
-- or hand-edited client can never undo a decision (SEC-02).
create or replace function private.bad_account_key(p_key_hash bigint, p_account_key text) returns text
language sql stable set search_path = '' as $$
  select case
    when p_account_key is null or p_account_key !~ '^(n:[0-9]{10}|e:[0-9a-f]{16})$' then 'accountKey has an invalid format'
    when d.action = 'detach' and p_account_key <> 'e:' || private.hex16(p_key_hash)
      then 'accountKey contradicts the stored detach decision (a decision was made during the import: start it again)'
    when d.action = 'attach' and p_account_key <> d.account_key
      then 'accountKey contradicts the stored attach decision (a decision was made during the import: start it again)'
  end
  from (select 1) x left join crm.val_decision d on d.key_hash = p_key_hash
$$;

create or replace function private.import_entries_core(p_run int, p_rows jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_ins int := 0;
  v_upd int := 0;
  v_ret int := 0;
  c_facets constant text[] := array['p.status','p.rodzaje','p.grp','p.spec','p.dz','p.fn','p.forma','p.formType','p.woj','r.src',
    'r.grupaPraktyk','r.gz','r.typ','r.rodzaj','r.rd','r.spec','r.zakres','r.forma','r.organ','r.status','r.woj'];
  c_woj   constant text[] := array['p.woj', 'r.woj'];
  c_stat  constant text[] := array['p.status', 'r.status'];
  c_legal constant text[] := array['p.forma', 'p.formType', 'r.forma', 'r.typ', 'r.grupaPraktyk', 'r.organ'];
  c_struct constant text[] := array['p.rodzaje', 'p.grp', 'p.spec', 'p.dz', 'p.fn', 'r.gz', 'r.rodzaj', 'r.rd', 'r.spec', 'r.zakres'];
  v_bad text;
  v_new int;
begin
  if to_regclass('pg_temp._imp') is not null then drop table pg_temp._imp; end if; -- COR-02
  create temporary table _imp (
    ord int, key_hash bigint, key_hex text, reg_key text, kind "char", src smallint, org text, ks text, kseq smallint,
    name text, nip text, email text, tel text, www text, emails text[], miasto text, kod text, wpis date, stan date,
    nz smallint, nk int, rec jsonb, facets jsonb, derived jsonb, h_all bigint, h_contact bigint, h_derived bigint,
    reg_org smallint, fv smallint[], cflags smallint, nums int[], mobile int, tel_norm int,
    old_id int, old_h_all bigint, old_in_register boolean, old_rec_same boolean, mask int, old_json jsonb, new_id int
  ) on commit drop;

  insert into _imp (ord, key_hash, key_hex, reg_key, kind, src, org, ks, kseq, name, nip, email, tel, www, emails, miasto, kod,
                    wpis, stan, nz, nk, rec, facets, derived, h_all, h_contact, h_derived)
  select t.ord::int, private.hash_from_hex(x."keyHash"), x."keyHash", x."regKey", x.kind::"char", private.src_index(x.src),
         coalesce(x.org, ''), x.ks, coalesce(x.kseq, 1), nullif(x.name, ''), nullif(x.nip, ''), nullif(x.email, ''),
         nullif(x.tel, ''), nullif(x.www, ''), case when cardinality(x.emails) > 0 then x.emails end, nullif(x.miasto, ''),
         nullif(x.kod, ''), x.wpis::date, x.stan::date, x.nz, x.nk, x.rec, coalesce(x.facets, '{}'::jsonb), x.derived,
         private.int64_from_text(x."hAll"), private.int64_from_text(x."hContact"), private.int64_from_text(x."hDerived")
  from jsonb_array_elements(p_rows) with ordinality as t(value, ord)
  cross join lateral jsonb_to_record(t.value) as x(
    "keyHash" text, "regKey" text, kind text, src text, org text, ks text, kseq smallint, name text, nip text, email text, tel text,
    www text, emails text[], miasto text, kod text, wpis text, stan text, nz smallint, nk int, rec jsonb, facets jsonb,
    derived jsonb, "hAll" text, "hContact" text, "hDerived" text);

  -- row validation (the whole call fails with CR422 and nothing is written)
  select 'keyHash=' || r.key_hex || ': ' || r.why into v_bad from (
    select i.key_hex, case
        when i.kind not in ('p', 'r') then 'kind'
        when i.src is null then 'src'
        when (i.kind = 'p') <> (i.src = 0) then 'kind and src disagree'
        when coalesce(i.ks, '') = '' then 'ks is empty'
        when strpos(i.org, '|') > 0 or strpos(i.ks, '|') > 0 then 'org and ks must not contain |' -- SEC-11: regKey separator
        when i.reg_key is null then 'regKey is required'
        when i.reg_key <> private.src_name(i.src) || '|' || i.org || '|' || i.ks || '|' || i.kseq then 'regKey does not match src, org, ks and kseq'
        when private.key_hash_of(i.reg_key) <> i.key_hash then 'keyHash does not match regKey'
        when length(i.name) > 1000 or length(i.org) > 300 or length(i.ks) > 300 then 'string above its cap'
        when length(i.email) > 500 or length(i.tel) > 500 or length(i.www) > 500 or length(i.miasto) > 500 or length(i.kod) > 500
             or length(i.nip) > 500 then 'string above its cap'
        when cardinality(i.emails) > 50 or exists (select 1 from unnest(i.emails) m where length(m) > 500) then 'emails above their cap'
        when i.rec is null or jsonb_typeof(i.rec) is distinct from 'object' or octet_length(i.rec::text) > 1000000 then 'rec'
        when private.bad_derived(i.derived) is not null then private.bad_derived(i.derived)
        else coalesce(private.bad_account_key(i.key_hash, i.derived ->> 'accountKey'), case when jsonb_typeof(i.facets) is distinct from 'object' then 'facets' end)
      end as why
    from _imp i) r
  where r.why is not null
  limit 1;
  if v_bad is not null then perform private.raise_err('CR422', 'invalid_payload', v_bad); end if;
  select 'keyHash=' || min(i.key_hex) || ': listed twice in one batch' into v_bad
  from _imp i group by i.key_hash having count(*) > 1 limit 1;
  if v_bad is not null then perform private.raise_err('CR422', 'invalid_payload', v_bad); end if;
  select 'keyHash=' || i.key_hex || ': facets' into v_bad
  from _imp i, jsonb_each(i.facets) f(key, value)
  where not (f.key = any (c_facets)) or jsonb_typeof(f.value) is distinct from 'array'
     or exists (select 1 from jsonb_array_elements_text(f.value) v(val) where length(v.val) > 300)
  limit 1;
  if v_bad is not null then perform private.raise_err('CR422', 'invalid_payload', v_bad); end if;

  -- SEC-07: one row may carry at most 2000 facet values (RD-6: the real register's largest podmiot has 371), a batch at most
  -- 2000 genuinely new dictionary values (the real file needs at most 136 per 500-row batch); the identity sequence is
  -- re-synchronised first under a lock (values burned by rolled-back calls are reclaimed; SEC-12)
  select 'keyHash=' || i.key_hex || ': more than 2000 facet values in one row' into v_bad
  from _imp i where (select coalesce(sum(jsonb_array_length(f.value)), 0) from jsonb_each(i.facets) f(key, value)
                     where jsonb_typeof(f.value) = 'array') > 2000 limit 1;
  if v_bad is not null then perform private.raise_err('CR422', 'invalid_payload', v_bad); end if;
  select count(*) into v_new from (
    select f.key as facet, v.val from _imp i cross join lateral jsonb_each(i.facets) f(key, value)
      cross join lateral jsonb_array_elements_text(f.value) v(val)
    union select 'org', i.org from _imp i) n
  where not exists (select 1 from crm.reg_dict d where d.facet = n.facet and d.val = n.val);
  if v_new > 2000 then perform private.raise_err('CR413', 'too_many_rows', 'more than 2000 new dictionary values in one batch'); end if;
  if v_new > 0 then
    perform private.lock_reg_dict();
    -- recount after the lock: a concurrent call of the same run may have committed some of the values meanwhile
    select count(*) into v_new from (
      select f.key as facet, v.val from _imp i cross join lateral jsonb_each(i.facets) f(key, value)
        cross join lateral jsonb_array_elements_text(f.value) v(val)
      union select 'org', i.org from _imp i) n
    where not exists (select 1 from crm.reg_dict d where d.facet = n.facet and d.val = n.val);
    perform setval('crm.reg_dict_id_seq', greatest((select max(d.id) from crm.reg_dict d), 1), (select count(*) > 0 from crm.reg_dict));
    if coalesce((select max(d.id) from crm.reg_dict d), 0) + v_new > 32767 then
      perform private.raise_err('CR422', 'dictionary_full', 'the facet dictionary (32767 values) would overflow');
    end if;
  end if;
  -- dictionary: only genuinely new values are inserted (ON CONFLICT alone would burn identity values)
  insert into crm.reg_dict (facet, val)
  select n.facet, n.val from (
    select f.key as facet, v.val from _imp i cross join lateral jsonb_each(i.facets) f(key, value)
      cross join lateral jsonb_array_elements_text(f.value) v(val)
    union select 'org', i.org from _imp i) n
  where not exists (select 1 from crm.reg_dict d where d.facet = n.facet and d.val = n.val)
  group by n.facet, n.val order by n.facet, n.val
  on conflict (facet, val) do nothing;

  update _imp i set
    reg_org = (select d.id from crm.reg_dict d where d.facet = 'org' and d.val = i.org),
    fv = (select coalesce(array_agg(distinct d.id), '{}'::smallint[])
          from jsonb_each(i.facets) f(key, value)
          cross join lateral jsonb_array_elements_text(f.value) v(val)
          join crm.reg_dict d on d.facet = f.key and d.val = v.val),
    cflags = ((case when coalesce(i.email, '') <> '' or cardinality(coalesce(i.emails, '{}')) > 0 then 1 else 0 end)
            | (case when i.tel is not null then 2 else 0 end)
            | (case when i.www is not null then 4 else 0 end)
            | (case when i.nip is not null then 8 else 0 end)
            | (case when i.derived ->> 'mobile' is not null then 16 else 0 end))::smallint,
    nums = case when jsonb_typeof(i.derived -> 'nums') = 'array' and jsonb_array_length(i.derived -> 'nums') > 0
                then (select array_agg(n::int) from jsonb_array_elements_text(i.derived -> 'nums') n) end,
    mobile = (i.derived ->> 'mobile')::int,
    tel_norm = (i.derived ->> 'telNorm')::int
  where true; -- pg_safeupdate (enabled for API roles on Supabase) refuses an UPDATE without WHERE

  -- classify against the database and compute the register diff for existing rows
  update _imp i set
    old_id = e.id, old_h_all = e.h_all, old_in_register = e.in_register,
    old_rec_same = (o.rec is not distinct from i.rec),
    mask = case when e.h_all = i.h_all and e.in_register then 0 else
      (case when e.email is distinct from i.email or e.emails is distinct from i.emails or e.tel is distinct from i.tel
              or e.www is distinct from i.www or (o.rec -> 'phones') is distinct from (i.rec -> 'phones') then 1 else 0 end)
      | (case when e.name is distinct from i.name then 2 else 0 end)
      | (case when e.nip is distinct from i.nip then 4 else 0 end)
      | (case when e.miasto is distinct from i.miasto or e.kod is distinct from i.kod
              or (o.rec -> 'ulica') is distinct from (i.rec -> 'ulica')
              or private.fv_group(e.fv, c_woj) <> private.fv_group(i.fv, c_woj) then 8 else 0 end)
      | (case when private.fv_group(e.fv, c_stat) <> private.fv_group(i.fv, c_stat) then 16 else 0 end)
      | (case when private.fv_group(e.fv, c_legal) <> private.fv_group(i.fv, c_legal) then 32 else 0 end)
      | (case when private.fv_group(e.fv, c_struct) <> private.fv_group(i.fv, c_struct) or e.nz is distinct from i.nz
              or e.nk is distinct from i.nk or e.spec1 is distinct from (i.derived ->> 'spec1')::smallint then 64 else 0 end)
      | (case when e.wpis is distinct from i.wpis or e.stan is distinct from i.stan then 128 else 0 end)
      | (case when (o.rec -> 'd') is distinct from (i.rec -> 'd') then 256 else 0 end)
    end
  from crm.reg_entry e
  left join lateral (select (b.recs::jsonb) -> e.id::text as rec from crm.reg_detail_block b where b.block_no = (e.id >> 5)) o on true
  where e.key_hash = i.key_hash;

  update _imp i set old_json =
      case when (i.mask & 1) <> 0 then jsonb_build_object('email', e.email, 'emails', to_jsonb(e.emails), 'tel', e.tel,
             'phones', o.rec -> 'phones', 'www', e.www) else '{}'::jsonb end
    || case when (i.mask & 2) <> 0 then jsonb_build_object('name', e.name) else '{}'::jsonb end
    || case when (i.mask & 4) <> 0 then jsonb_build_object('nip', e.nip) else '{}'::jsonb end
    || case when (i.mask & 8) <> 0 then jsonb_build_object('miasto', e.miasto, 'kod', e.kod, 'ulica', o.rec -> 'ulica',
             'woj', private.fv_values(e.fv, c_woj)) else '{}'::jsonb end
    || case when (i.mask & 16) <> 0 then jsonb_build_object('status', private.fv_values(e.fv, c_stat)) else '{}'::jsonb end
  from crm.reg_entry e
  left join lateral (select (b.recs::jsonb) -> e.id::text as rec from crm.reg_detail_block b where b.block_no = (e.id >> 5)) o on true
  where e.id = i.old_id and (i.mask & 31) <> 0;

  -- compact history: changed rows with a real difference, and every returned row
  insert into crm.reg_change (run_id, entry_id, change, fields, old)
  select p_run, i.old_id, case when i.old_in_register then 1 else 2 end, i.mask, nullif(i.old_json, '{}'::jsonb)
  from _imp i
  where i.old_id is not null and ((not i.old_in_register) or (i.old_h_all <> i.h_all and i.mask <> 0))
  on conflict (entry_id, run_id) do nothing;

  -- update changed / returned rows
  with upd as (
    update crm.reg_entry e set
      name = i.name, nip = i.nip, nip_status = (i.derived ->> 'nipStatus')::smallint,
      entity_type = (i.derived ->> 'entityType')::smallint, account_key = i.derived ->> 'accountKey',
      account_size = least((i.derived ->> 'accountSize')::int, 32767), is_account_primary = (i.derived ->> 'isAccountPrimary')::boolean,
      fv = i.fv, emails = i.emails, nums = i.nums, email = i.email, tel = i.tel, www = i.www, mobile = i.mobile,
      tel_norm = i.tel_norm, tel_shared = (i.derived ->> 'telShared')::int, cflags = i.cflags, miasto = i.miasto, kod = i.kod,
      wpis = i.wpis, stan = i.stan, nz = i.nz, nk = i.nk, spec1 = (i.derived ->> 'spec1')::smallint,
      q_email = (i.derived ->> 'qEmail')::smallint, q_phone = (i.derived ->> 'qPhone')::smallint,
      qflags = (i.derived ->> 'qflags')::int, in_register = true, gone_run = null,
      last_change_run = case when i.mask <> 0 or not i.old_in_register then p_run else e.last_change_run end,
      h_all = i.h_all, h_contact = i.h_contact, h_derived = i.h_derived
    from _imp i
    where e.id = i.old_id and (i.old_h_all <> i.h_all or not i.old_in_register)
    returning i.old_in_register as was_in)
  select count(*) filter (where was_in), count(*) filter (where not was_in) into v_upd, v_ret from upd;

  -- insert new rows (ids follow the file order, so new entries fill new detail blocks)
  with ins as (
    insert into crm.reg_entry (key_hash, kind, src, reg_org, ks, kseq, name, nip, nip_status, entity_type, account_key, account_size,
        is_account_primary, fv, emails, nums, email, tel, www, mobile, tel_norm, tel_shared, cflags, miasto, kod, wpis, stan,
        nz, nk, spec1, q_email, q_phone, qflags, in_register, first_run, h_all, h_contact, h_derived)
    select i.key_hash, i.kind, i.src, i.reg_org, i.ks, i.kseq, i.name, i.nip, (i.derived ->> 'nipStatus')::smallint,
           (i.derived ->> 'entityType')::smallint, i.derived ->> 'accountKey', least((i.derived ->> 'accountSize')::int, 32767),
           (i.derived ->> 'isAccountPrimary')::boolean, i.fv, i.emails, i.nums, i.email, i.tel, i.www, i.mobile, i.tel_norm,
           (i.derived ->> 'telShared')::int, i.cflags, i.miasto, i.kod, i.wpis, i.stan, i.nz, i.nk, (i.derived ->> 'spec1')::smallint,
           (i.derived ->> 'qEmail')::smallint, (i.derived ->> 'qPhone')::smallint, (i.derived ->> 'qflags')::int, true, p_run,
           i.h_all, i.h_contact, i.h_derived
    from _imp i where i.old_id is null order by i.ord
    returning id, key_hash),
  setid as (update _imp i set new_id = ins.id from ins where ins.key_hash = i.key_hash returning 1)
  select count(*) into v_ins from setid;

  -- detail blocks: new rows, and existing rows whose detail really changed
  insert into crm.reg_detail_block (block_no, recs)
  select (x.id >> 5), jsonb_object_agg(x.id::text, x.rec)::text
  from (select coalesce(i.new_id, i.old_id) as id, i.rec from _imp i
        where i.new_id is not null
           or (i.old_id is not null and not i.old_rec_same and (i.old_h_all <> i.h_all or not i.old_in_register))) x
  group by (x.id >> 5)
  on conflict (block_no) do update set recs = (crm.reg_detail_block.recs::jsonb || excluded.recs::jsonb)::text;

  return jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'returned', v_ret);
exception
  when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow
     or null_value_not_allowed or not_null_violation or string_data_right_truncation or invalid_parameter_value then
    perform private.raise_err('CR422', 'invalid_payload', 'a row has a field of the wrong type or a missing required field (' || sqlerrm || ')');
    return null;
end $$;

create or replace function api.import_entries(p_run_id int, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '55s' as $$
declare v_me smallint := private.require_owner();
begin
  perform private.require_run(p_run_id, v_me);
  if jsonb_typeof(p_rows) is distinct from 'array' then perform private.raise_err('CR422', 'invalid_payload', 'rows must be an array'); end if;
  if jsonb_array_length(p_rows) > 1000 then perform private.raise_err('CR413', 'too_many_rows', 'more than 1000 rows'); end if;
  return private.import_entries_core(p_run_id, p_rows);
end $$;

create or replace function api.import_derived(p_run_id int, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '55s' as $$
declare
  v_me  smallint := private.require_owner();
  v_n   int;
  v_bad text;
begin
  perform private.require_run(p_run_id, v_me);
  if jsonb_typeof(p_rows) is distinct from 'array' then perform private.raise_err('CR422', 'invalid_payload', 'rows must be an array'); end if;
  if jsonb_array_length(p_rows) > 2000 then perform private.raise_err('CR413', 'too_many_rows', 'more than 2000 rows'); end if;
  select 'keyHash=' || x."keyHash" || ': ' || coalesce(private.bad_derived(x.derived),
           private.bad_account_key(private.hash_from_hex(x."keyHash"), x.derived ->> 'accountKey')) into v_bad
  from jsonb_to_recordset(p_rows) as x("keyHash" text, derived jsonb, "hDerived" text)
  where coalesce(private.bad_derived(x.derived), private.bad_account_key(private.hash_from_hex(x."keyHash"), x.derived ->> 'accountKey')) is not null
  limit 1;
  if v_bad is not null then perform private.raise_err('CR422', 'invalid_payload', v_bad); end if;
  -- SEC-09: the same entry twice in one batch is refused, as in import_entries
  select 'keyHash=' || x."keyHash" || ': listed twice in one batch' into v_bad
  from jsonb_to_recordset(p_rows) as x("keyHash" text) group by x."keyHash" having count(*) > 1 limit 1;
  if v_bad is not null then perform private.raise_err('CR422', 'invalid_payload', v_bad); end if;
  with src as (
    select private.hash_from_hex(x."keyHash") as key_hash, x.derived, private.int64_from_text(x."hDerived") as h_derived
    from jsonb_to_recordset(p_rows) as x("keyHash" text, derived jsonb, "hDerived" text)),
  upd as (
    update crm.reg_entry e set
      nip_status = (s.derived ->> 'nipStatus')::smallint, entity_type = (s.derived ->> 'entityType')::smallint,
      account_key = s.derived ->> 'accountKey', account_size = least((s.derived ->> 'accountSize')::int, 32767),
      is_account_primary = (s.derived ->> 'isAccountPrimary')::boolean, tel_shared = (s.derived ->> 'telShared')::int,
      q_email = (s.derived ->> 'qEmail')::smallint, q_phone = (s.derived ->> 'qPhone')::smallint,
      qflags = (s.derived ->> 'qflags')::int, h_derived = s.h_derived
    from src s where e.key_hash = s.key_hash and e.h_derived is distinct from s.h_derived
    returning 1)
  select count(*) into v_n from upd;
  return jsonb_build_object('updated', v_n);
exception when invalid_text_representation or numeric_value_out_of_range or not_null_violation then
  perform private.raise_err('CR422', 'invalid_payload', 'a derived row has a field of the wrong type');
  return null;
end $$;

create or replace function api.import_gone(p_run_id int, p_key_hashes jsonb) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '55s' as $$
declare
  v_me  smallint := private.require_owner();
  r     crm.import_run;
  v_n   int;
begin
  r := private.require_run(p_run_id, v_me);
  if jsonb_typeof(p_key_hashes) is distinct from 'array' then perform private.raise_err('CR422', 'invalid_payload', 'key hashes must be an array'); end if;
  if jsonb_array_length(p_key_hashes) > 5000 then perform private.raise_err('CR413', 'too_many_rows', 'more than 5000 key hashes'); end if;
  with upd as (
    update crm.reg_entry e set in_register = false, gone_run = p_run_id
    where e.in_register
      and e.key_hash in (select private.hash_from_hex(h) from jsonb_array_elements_text(p_key_hashes) h)
      and e.src in (select private.src_index(s) from unnest(r.full_sources) s)
    returning 1)
  select count(*) into v_n from upd;
  return jsonb_build_object('gone', v_n);
end $$;

create or replace function api.import_proposals(p_run_id int, p_rows jsonb, p_final boolean) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '55s' as $$
declare
  v_me     smallint := private.require_owner();
  v_new    int := 0;
  v_old    int := 0;
  v_reopen int := 0;
  v_stale  int := 0;
begin
  perform private.require_run(p_run_id, v_me);
  if jsonb_typeof(p_rows) is distinct from 'array' then perform private.raise_err('CR422', 'invalid_payload', 'rows must be an array'); end if;
  if jsonb_array_length(p_rows) > 1000 then perform private.raise_err('CR413', 'too_many_rows', 'more than 1000 rows'); end if;

  if to_regclass('pg_temp._prop') is not null then drop table pg_temp._prop; end if; -- COR-02
  create temporary table _prop (kind text, match_value text, confidence smallint, group_key text, members text[]) on commit drop;
  insert into _prop
  select distinct on (x.kind, x."matchValue") x.kind, left(x."matchValue", 500), x.confidence, x."groupKey",
         (select array_agg(distinct m order by m) from unnest(x.members) m)
  from jsonb_to_recordset(p_rows) as x(kind text, "matchValue" text, confidence smallint, "groupKey" text, members text[])
  order by x.kind, x."matchValue";
  if exists (select 1 from _prop where kind is null or kind not in ('account_check','person','partner','email','domain','www','phone','reg_duplicate')
             or match_value is null or confidence is null or confidence not between 0 and 100 or group_key is null
             or members is null or cardinality(members) < 1) then
    perform private.raise_err('CR422', 'invalid_payload', 'proposal rows: kind, matchValue, confidence 0..100, groupKey and members are required');
  end if;

  -- Existing rows. Open/stale ones take the new members; decided ones keep their decision unless members appear that were
  -- not seen at decision time (then they reopen, the previous decision stays visible, new_members lists the additions).
  with old as (
    select p.id, p.status as old_status, p.decided_members from crm.val_proposal p join _prop n on n.kind = p.kind and n.match_value = p.match_value),
  upd as (
    update crm.val_proposal p set
      confidence = n.confidence, group_key = n.group_key, members = n.members, last_run = p_run_id,
      new_members = case when o.old_status in (1, 2)
        then coalesce((select array_agg(m order by m) from unnest(n.members) m where m <> all (coalesce(o.decided_members, '{}'))), '{}')
        else '{}'::text[] end,
      status = case
        when o.old_status in (0, 3) then 0
        when exists (select 1 from unnest(n.members) m where m <> all (coalesce(o.decided_members, '{}'))) then 0
        else o.old_status end
    from _prop n join old o on true
    where p.id = o.id and n.kind = p.kind and n.match_value = p.match_value
    returning (o.old_status in (1, 2) and p.status = 0) as reopened)
  select count(*), count(*) filter (where reopened) into v_old, v_reopen from upd;

  insert into crm.val_proposal (kind, match_value, confidence, group_key, members, last_run)
  select n.kind, n.match_value, n.confidence, n.group_key, n.members, p_run_id from _prop n
  where not exists (select 1 from crm.val_proposal p where p.kind = n.kind and p.match_value = n.match_value)
  order by n.kind, n.match_value;
  get diagnostics v_new = row_count;

  if p_final then
    -- open proposals of the kinds this run produced that it did not send again are no longer valid
    with produced as (select distinct kind from crm.val_proposal where last_run = p_run_id),
    st as (update crm.val_proposal p set status = 3
           where p.status = 0 and p.last_run is distinct from p_run_id and p.kind in (select kind from produced) returning 1)
    select count(*) into v_stale from st;
  end if;
  return jsonb_build_object('upserted', v_new + v_old, 'reopened', v_reopen, 'staled', v_stale);
end $$;

create or replace function api.import_finish(p_run_id int, p_counts jsonb) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '55s' as $$
declare
  v_me   smallint := private.require_owner();
  r      crm.import_run;
  v_keep int := private.setting_int('history.keepRuns', 24);
  v_cut  int;
begin
  perform private.require_run(p_run_id, v_me);
  update crm.import_run set status = 'applied', counts = p_counts, finished_at = now() where id = p_run_id returning * into r;
  select min(k.id) into v_cut from (select id from crm.import_run where status = 'applied' order by id desc limit v_keep) k;
  delete from crm.reg_change where run_id < v_cut;
  analyze crm.reg_entry;
  return private.run_json(r);
end $$;

create or replace function api.import_abort(p_run_id int, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_owner();
  r    crm.import_run;
begin
  select * into r from crm.import_run where id = p_run_id for update;
  if not found then perform private.raise_err('CR404', 'not_found', 'import run ' || p_run_id); end if;
  if r.started_by <> v_me then perform private.raise_err('CR403', 'owner_only', 'the import run was started by another user'); end if;
  if r.status = 'running' then
    update crm.import_run set status = 'aborted', finished_at = now(), error = left(p_reason, 1000) where id = p_run_id returning * into r;
  end if;
  return private.run_json(r);
end $$;

create or replace function api.import_runs() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_owner();
begin
  return (select coalesce(jsonb_agg(private.run_json(r) order by r.id desc), '[]')
          from (select * from crm.import_run order by id desc limit 50) r);
end $$;

-- Leads that have CRM work (status, owner, step, contact, tags, dnc, validation, activity, task, contact, list); used by the preview.
create or replace function private.has_crm_work(e crm.reg_entry) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from crm.lead l where l.entry_id = e.id
                 and (l.status_id <> private.default_status() or l.owner_id is not null or l.next_step_at is not null
                      or l.last_contact_at is not null or cardinality(l.tags) > 0 or l.dnc or l.validation is not null))
      or exists (select 1 from crm.activity a where a.entry_id = e.id)
      or exists (select 1 from crm.task t where t.entry_id = e.id)
      or exists (select 1 from crm.lead_contact c where c.entry_id = e.id)
      or exists (select 1 from crm.list_member m where m.entry_id = e.id)
$$;

create or replace function api.import_changes(p_run_id int, p_change text, p_only_crm boolean, p_offset int, p_limit int) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '50s' as $$
declare
  v_me  smallint := private.require_owner();
  v_src text;
  v_res jsonb;
begin
  if p_limit is not null and p_limit > 200 then perform private.raise_err('CR413', 'too_many_rows', 'limit above 200'); end if;
  if p_limit is null or p_limit < 1 or p_offset is null or p_offset < 0 then perform private.raise_err('CR422', 'invalid_payload', 'offset/limit'); end if;
  v_src := case p_change
    when 'new' then 'select e.id, 0 as fields, null::jsonb as old from crm.reg_entry e where e.first_run = $1'
    when 'gone' then 'select e.id, 0 as fields, null::jsonb as old from crm.reg_entry e where e.gone_run = $1 and not e.in_register'
    when 'changed' then 'select c.entry_id as id, c.fields, c.old from crm.reg_change c where c.run_id = $1 and c.change = 1'
    when 'returned' then 'select c.entry_id as id, c.fields, c.old from crm.reg_change c where c.run_id = $1 and c.change = 2'
    else null end;
  if v_src is null then perform private.raise_err('CR422', 'invalid_payload', 'change must be new|gone|changed|returned'); end if;
  execute format(
    'select coalesce(jsonb_agg(t.item order by t.nm, t.id), ''[]'') from (select e.id, e.name collate crm.pl_ci as nm, jsonb_build_object(''row'', private.lead_row(e, l), ''change'', %L, ''fields'', to_jsonb(private.change_groups(s.fields)), ''old'', s.old) as item from (%s) s join crm.reg_entry e on e.id = s.id left join crm.lead l on l.entry_id = e.id where (not %L::boolean or private.has_crm_work(e)) order by e.name collate crm.pl_ci nulls last, e.id offset %s limit %s) t',
    p_change, v_src, coalesce(p_only_crm, false), p_offset, p_limit) using p_run_id into v_res;
  return v_res;
end $$;

-- Addition to the contract (CONTRACT Deviations): which of the given entries (key hashes, 16 hex) carry CRM work.
-- The import preview uses it to warn about gone / contact-changed leads the team is working on.
create or replace function api.import_crm_work(p_key_hashes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_owner();
begin
  if jsonb_typeof(p_key_hashes) is distinct from 'array' then perform private.raise_err('CR422', 'invalid_payload', 'key hashes must be an array'); end if;
  if jsonb_array_length(p_key_hashes) > 5000 then perform private.raise_err('CR413', 'too_many_rows', 'more than 5000 key hashes'); end if;
  return (select coalesce(jsonb_agg(private.hex16(e.key_hash) order by e.id), '[]')
          from crm.reg_entry e
          where e.key_hash in (select private.hash_from_hex(h) from jsonb_array_elements_text(p_key_hashes) h)
            and private.has_crm_work(e));
end $$;

select private.apply_api_grants();

