-- Filter compiler (DATA_MODEL 6), sort clause, row builders shared by the RPCs.
-- The compiler returns a WHERE fragment over `crm.reg_entry e left join crm.lead l on l.entry_id = e.id`.
-- Every value is cast to its type or quoted with %L before it is embedded, so the text is injection-safe.

create or replace function private.int_array(p_json jsonb) returns int[]
language sql immutable parallel safe set search_path = '' as $$
  select case when jsonb_typeof(p_json) = 'array'
    then coalesce((select array_agg(x::int) from jsonb_array_elements_text(p_json) as t(x)), '{}'::int[])
    else '{}'::int[] end
$$;

create or replace function private.like_escape(p_text text) returns text
language sql immutable parallel safe set search_path = '' as
$$ select replace(replace(replace(p_text, '\', '\\'), '%', '\%'), '_', '\_') $$;

create or replace function private.compile_filter(p_filter jsonb, p_me smallint, p_skip text default null)
returns text language plpgsql stable set search_path = '' as $$
declare
  f      jsonb := coalesce(p_filter, '{}'::jsonb);
  parts  text[] := '{}';
  facets constant text[] := array['p.status','p.rodzaje','p.grp','p.spec','p.dz','p.fn','p.forma','p.formType','p.woj',
    'r.src','r.grupaPraktyk','r.gz','r.typ','r.rodzaj','r.rd','r.spec','r.zakres','r.forma','r.organ','r.status','r.woj'];
  v_kind text;
  k      text;
  vals   jsonb;
  fk     text;
  ids    smallint[];
  pred   text;
  m      int;
  n      int;
  v      text;
  rd     date;
  dflt   smallint := private.default_status();
  q      text;
  pat    text;
  digits text;
  cond   text[];
  arr    int[];
  has_none boolean;
  el     text;
  mask   constant int := private.qflag_problem_mask();
begin
  if jsonb_typeof(f) is distinct from 'object' then
    perform private.raise_err('CR422', 'invalid_payload', 'filter must be an object');
  end if;
  v_kind := coalesce(f ->> 'kind', 'all');
  if v_kind not in ('p', 'r', 'all') then
    perform private.raise_err('CR422', 'invalid_payload', 'filter.kind');
  end if;
  if v_kind <> 'all' then parts := parts || format('e.kind = %L', v_kind); end if;

  -- register facets: OR within a facet, AND across facets
  if jsonb_typeof(f -> 'sel') = 'object' then
    for k, vals in select key, value from jsonb_each(f -> 'sel') loop
      if not (k = any (facets)) then
        perform private.raise_err('CR422', 'invalid_payload', 'filter.sel: unknown facet ' || left(k, 40));
      end if;
      if k = p_skip or jsonb_typeof(vals) is distinct from 'array' or jsonb_array_length(vals) = 0 then continue; end if;
      fk := left(k, 1);
      if v_kind <> 'all' and fk <> v_kind then continue; end if;
      if k = 'p.fn' then
        -- tree prefixes; a value ending with '=' matches that code exactly
        select array_agg(d.id) into ids from crm.reg_dict d
        where d.facet = k and exists (
          select 1 from jsonb_array_elements_text(vals) as s(x)
          where d.val = x
             or (right(x, 1) = '=' and d.val = left(x, -1))
             or (right(x, 1) <> '=' and d.val like private.like_escape(x) || '%'));
      else
        select array_agg(d.id) into ids from crm.reg_dict d
        where d.facet = k and d.val in (select jsonb_array_elements_text(vals));
      end if;
      if ids is null then pred := 'false'; else pred := format('e.fv && %L::smallint[]', ids::text); end if;
      if v_kind = 'all' then pred := format('(e.kind <> %L or %s)', fk, pred); end if;
      parts := parts || pred;
    end loop;
  end if;

  -- contact presence
  if jsonb_typeof(f -> 'contact') = 'object' then
    m := (case when f #>> '{contact,email}' = 'true' then 1 else 0 end)
       + (case when f #>> '{contact,tel}' = 'true' then 2 else 0 end)
       + (case when f #>> '{contact,www}' = 'true' then 4 else 0 end)
       + (case when f #>> '{contact,nip}' = 'true' then 8 else 0 end)
       + (case when f #>> '{contact,mobile}' = 'true' then 16 else 0 end);
    if m > 0 then parts := parts || format('(e.cflags & %s) = %s', m, m); end if;
  end if;

  -- free text: name, NIP, e-mail, phone
  q := nullif(btrim(coalesce(f ->> 'q', '')), '');
  if q is not null then
    if length(q) > 200 then perform private.raise_err('CR422', 'invalid_payload', 'filter.q too long'); end if;
    pat := '%' || private.like_escape(private.f_unaccent(lower(q))) || '%';
    digits := regexp_replace(q, '\D', '', 'g');
    cond := array[format('private.f_unaccent(lower(e.name)) like %L', pat),
                  format('lower(e.email) like %L', '%' || private.like_escape(lower(q)) || '%'),
                  format('lower(array_to_string(e.emails, '' '')) like %L', '%' || private.like_escape(lower(q)) || '%')];
    -- NIP contains: only when the text has no letters (otherwise "Lekarz 24" would match every NIP with 24)
    if length(digits) >= 3 and q !~ '[[:alpha:]]' then
      cond := cond || format('e.nip like %L', '%' || digits || '%');
    end if;
    if length(digits) >= 9 and q !~ '[[:alpha:]]' then
      cond := cond || format('e.nums @> array[%s]::int[]', right(digits, 9)::int);
    end if;
    parts := parts || ('(' || array_to_string(cond, ' or ') || ')');
  end if;

  if nullif(btrim(coalesce(f ->> 'miasto', '')), '') is not null then
    parts := parts || format('private.f_unaccent(lower(e.miasto)) like %L',
      '%' || private.like_escape(private.f_unaccent(lower(btrim(f ->> 'miasto')))) || '%');
  end if;

  -- dates and counters
  n := coalesce((f ->> 'wpisRel')::int, 0);
  if n not in (0, 1, 6, 12) then perform private.raise_err('CR422', 'invalid_payload', 'filter.wpisRel'); end if;
  if n > 0 then
    rd := coalesce(private.latest_report_date(), private.today());
    parts := parts || format('e.wpis >= %L::date', (rd - make_interval(months => n))::date);
  else
    if f ->> 'wpisOd' is not null then parts := parts || format('e.wpis >= %L::date', (f ->> 'wpisOd')::date); end if;
    if f ->> 'wpisDo' is not null then parts := parts || format('e.wpis <= %L::date', (f ->> 'wpisDo')::date); end if;
  end if;
  if f ->> 'stanOd' is not null then parts := parts || format('e.stan >= %L::date', (f ->> 'stanOd')::date); end if;
  if f ->> 'spec1Min' is not null then
    parts := parts || format('(e.kind <> %L or e.spec1 >= %s)', 'p', (f ->> 'spec1Min')::int);
  end if;
  if f ->> 'nkMin' is not null then
    parts := parts || format('(e.kind <> %L or e.nk >= %s)', 'p', (f ->> 'nkMin')::int);
  end if;
  if jsonb_typeof(f -> 'entityType') = 'array' and jsonb_array_length(f -> 'entityType') > 0 then
    parts := parts || format('e.entity_type = any (%L::smallint[])', private.int_array(f -> 'entityType')::text);
  end if;
  if jsonb_typeof(f -> 'nipStatus') = 'array' and jsonb_array_length(f -> 'nipStatus') > 0 then
    parts := parts || format('e.nip_status = any (%L::smallint[])', private.int_array(f -> 'nipStatus')::text);
  end if;
  if f ->> 'qflagsAny' is not null and (f ->> 'qflagsAny')::int <> 0 then
    parts := parts || format('(e.qflags & %s) <> 0', (f ->> 'qflagsAny')::int);
  end if;

  v := coalesce(f ->> 'inRegister', 'yes');
  if v = 'yes' then parts := parts || 'e.in_register'::text;
  elsif v = 'no' then parts := parts || 'not e.in_register'::text;
  elsif v <> 'all' then perform private.raise_err('CR422', 'invalid_payload', 'filter.inRegister'); end if;
  if f ->> 'accountPrimaryOnly' = 'true' then parts := parts || 'e.is_account_primary'::text; end if;

  if f ->> 'newInRun' is not null then
    n := case when f ->> 'newInRun' = 'last' then private.latest_run() else (f ->> 'newInRun')::int end;
    parts := parts || case when n is null then 'false' else format('e.first_run = %s', n) end;
  end if;
  if f ->> 'changedInRun' is not null then
    n := case when f ->> 'changedInRun' = 'last' then private.latest_run() else (f ->> 'changedInRun')::int end;
    parts := parts || case when n is null then 'false'
                      else format('(e.last_change_run = %s and e.first_run is distinct from %s)', n, n) end;
  end if;

  -- CRM filters (a missing lead row means default values)
  if jsonb_typeof(f -> 'status') = 'array' and jsonb_array_length(f -> 'status') > 0 then
    parts := parts || format('coalesce(l.status_id, %s) = any (%L::smallint[])', dflt, private.int_array(f -> 'status')::text);
  end if;
  if jsonb_typeof(f -> 'owner') = 'array' and jsonb_array_length(f -> 'owner') > 0 then
    arr := '{}'; has_none := false;
    for el in select jsonb_array_elements_text(f -> 'owner') loop
      if el = 'none' then has_none := true;
      elsif el = 'me' then arr := arr || p_me::int;
      else arr := arr || el::int; end if;
    end loop;
    parts := parts || format('(l.owner_id = any (%L::smallint[])%s)', arr::text, case when has_none then ' or l.owner_id is null' else '' end);
  end if;
  if jsonb_typeof(f -> 'tags') = 'array' and jsonb_array_length(f -> 'tags') > 0 then
    parts := parts || format('l.tags %s %L::smallint[]',
      case when f ->> 'tagsMode' = 'all' then '@>' else '&&' end, private.int_array(f -> 'tags')::text);
  end if;
  if jsonb_typeof(f -> 'validation') = 'array' and jsonb_array_length(f -> 'validation') > 0 then
    parts := parts || format(
      'coalesce(l.validation, case when (e.qflags & %s) <> 0 or e.account_key in (select account_key from crm.v_open_member) then 1 else 0 end) = any (%L::smallint[])',
      mask, private.int_array(f -> 'validation')::text);
  end if;
  v := f ->> 'nextStep';
  if v is not null then
    parts := parts || case v
      when 'overdue' then format('l.next_step_at < %L::date', private.today())
      when 'today'   then format('l.next_step_at = %L::date', private.today())
      when 'due'     then format('l.next_step_at <= %L::date', private.today())
      when 'week'    then format('(l.next_step_at >= %L::date and l.next_step_at <= %L::date)', private.today(), private.today() + 7)
      when 'none'    then 'l.next_step_at is null'
      when 'any'     then 'l.next_step_at is not null'
      else 'false' end;
    if v not in ('overdue', 'today', 'due', 'week', 'none', 'any') then
      perform private.raise_err('CR422', 'invalid_payload', 'filter.nextStep');
    end if;
  end if;
  v := coalesce(f ->> 'dnc', 'all');
  if v = 'exclude' then parts := parts || 'not coalesce(l.dnc, false)'::text;
  elsif v = 'only' then parts := parts || 'coalesce(l.dnc, false)'::text;
  elsif v <> 'all' then perform private.raise_err('CR422', 'invalid_payload', 'filter.dnc'); end if;
  v := f ->> 'lastContact';
  if v is not null then
    parts := parts || case v
      when 'never'   then 'l.last_contact_at is null'
      when '7d'      then 'l.last_contact_at >= now() - interval ''7 days'''
      when '30d'     then 'l.last_contact_at >= now() - interval ''30 days'''
      when '90d'     then 'l.last_contact_at >= now() - interval ''90 days'''
      when 'older90' then 'l.last_contact_at < now() - interval ''90 days'''
      else null end;
    if v not in ('never', '7d', '30d', '90d', 'older90') then
      perform private.raise_err('CR422', 'invalid_payload', 'filter.lastContact');
    end if;
  end if;
  if f ->> 'listId' is not null then
    parts := parts || format('exists (select 1 from crm.list_member lm where lm.list_id = %s and lm.entry_id = e.id)', (f ->> 'listId')::int);
  end if;
  v := f ->> 'network';
  if v is not null then
    parts := parts || case
      when v = 'any'  then 'exists (select 1 from crm.network_member nm where nm.account_key = e.account_key)'
      when v = 'none' then 'not exists (select 1 from crm.network_member nm where nm.account_key = e.account_key)'
      else format('exists (select 1 from crm.network_member nm where nm.account_key = e.account_key and nm.network_id = %s)', v::int) end;
  end if;
  if f ->> 'openProposal' = 'true' then
    parts := parts || 'e.account_key in (select account_key from crm.v_open_member)'::text;
  end if;
  if jsonb_typeof(f -> 'entryIds') = 'array' then
    arr := private.int_array(f -> 'entryIds');
    if cardinality(arr) > 5000 then perform private.raise_err('CR413', 'too_many_rows', 'entryIds above 5000'); end if;
    parts := parts || format('e.id = any (%L::int[])', arr::text);
  end if;

  return case when cardinality(parts) = 0 then 'true' else array_to_string(parts, ' and ') end;
exception
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow
     or numeric_value_out_of_range or invalid_parameter_value then
    perform private.raise_err('CR422', 'invalid_payload', 'filter value has the wrong type (' || sqlerrm || ')');
    return null;
end $$;

create or replace function private.sort_clause(p_sort jsonb) returns text
language plpgsql stable set search_path = '' as $$
declare
  k   text := coalesce(p_sort ->> 'key', 'name');
  dir text := lower(coalesce(p_sort ->> 'dir', 'asc'));
  expr text;
begin
  if dir not in ('asc', 'desc') then perform private.raise_err('CR422', 'invalid_payload', 'sort.dir'); end if;
  expr := case k
    when 'name'        then 'e.name collate crm.pl_ci'
    when 'miasto'      then 'e.miasto collate crm.pl_ci'
    when 'wpis'        then 'e.wpis'
    when 'stan'        then 'e.stan'
    when 'status'      then format('(select s.sort from crm.lead_status s where s.id = coalesce(l.status_id, %s))', private.default_status())
    when 'owner'       then '(select m.display_name from crm.team_member m where m.id = l.owner_id) collate crm.pl_ci'
    when 'nextStep'    then 'l.next_step_at'
    when 'lastContact' then 'l.last_contact_at'
    when 'qEmail'      then 'e.q_email'
    when 'spec1'       then 'e.spec1'
    when 'nk'          then 'e.nk'
    when 'updated'     then 'l.updated_at'
    else null end;
  if expr is null then perform private.raise_err('CR422', 'invalid_payload', 'sort.key'); end if;
  return expr || ' ' || dir || ' nulls last, e.id';
end $$;

-- One LeadRow (contract.ts) from a register entry and its (possibly absent) lead row.
create or replace function private.lead_row(e crm.reg_entry, l crm.lead) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id,
    'kind', e.kind::text,
    'src', private.src_name(e.src),
    'name', e.name,
    'nip', e.nip,
    'email', coalesce(
      (select c.value from crm.lead_contact c
        where c.entry_id = e.id and c.kind = 'email' and c.source = 'crm' and c.is_primary and c.status <> 'invalid' limit 1),
      case when exists (select 1 from crm.lead_contact c
                         where c.entry_id = e.id and c.kind = 'email' and c.source = 'register' and c.status = 'invalid'
                           and c.value_norm = private.normalize_email(e.email))
           then null else e.email end),
    'tel', coalesce(
      (select c.value from crm.lead_contact c
        where c.entry_id = e.id and c.kind = 'phone' and c.source = 'crm' and c.is_primary and c.status <> 'invalid' limit 1),
      case when e.tel_norm is not null and exists (select 1 from crm.lead_contact c
                         where c.entry_id = e.id and c.kind = 'phone' and c.source = 'register' and c.status = 'invalid'
                           and c.value_norm = e.tel_norm::text)
           then null else e.tel end),
    'mobile', e.mobile::text,
    'www', e.www,
    'miasto', e.miasto,
    'woj', (select d.val from crm.reg_dict d where d.id = any (e.fv) and d.facet in ('p.woj', 'r.woj') limit 1),
    'wpis', e.wpis,
    'stan', e.stan,
    'nz', e.nz,
    'nk', e.nk,
    'spec1', e.spec1,
    'entityType', e.entity_type,
    'inRegister', e.in_register,
    'qEmail', e.q_email,
    'qPhone', e.q_phone,
    'qflags', e.qflags,
    'accountKey', e.account_key,
    'accountSize', e.account_size,
    'statusId', coalesce(l.status_id, private.default_status()),
    'ownerId', l.owner_id,
    'tags', to_jsonb(coalesce(l.tags, '{}'::smallint[])),
    'validation', coalesce(l.validation,
      case when (e.qflags & private.qflag_problem_mask()) <> 0
             or exists (select 1 from crm.val_proposal p
                         where p.status = 0 and p.confidence >= private.min_conf() and p.members @> array[e.account_key])
           then 1 else 0 end),
    'validationIsDerived', l.validation is null,
    'dnc', coalesce(l.dnc, false),
    'nextStepAt', l.next_step_at,
    'nextStepNote', l.next_step_note,
    'lastContactAt', l.last_contact_at,
    'networkId', (select nm.network_id from crm.network_member nm where nm.account_key = e.account_key),
    'version', coalesce(l.version, 0))
$$;

-- LeadRow[] for the given entry ids, in the order of the ids.
create or replace function private.lead_rows(p_ids int[]) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(private.lead_row(e, l) order by u.ord), '[]'::jsonb)
  from unnest(coalesce(p_ids, '{}'::int[])) with ordinality as u(id, ord)
  join crm.reg_entry e on e.id = u.id
  left join crm.lead l on l.entry_id = e.id
$$;

create or replace function private.lead_row_by_id(p_id int) returns jsonb
language sql stable set search_path = '' as $$ select private.lead_rows(array[p_id]) -> 0 $$;

create or replace function private.reg_key(e crm.reg_entry) returns text
language sql stable set search_path = '' as $$
  select private.src_name(e.src) || '|' || coalesce((select d.val from crm.reg_dict d where d.id = e.reg_org), '')
         || '|' || e.ks || '|' || e.kseq
$$;

-- Entry id for a register key string `${src}|${org}|${ks}|${kseq}`, or null.
create or replace function private.entry_id_by_reg_key(p_reg_key text) returns int
language sql stable set search_path = '' as
$$ select id from crm.reg_entry where key_hash = private.key_hash_of(p_reg_key) $$;

-- Names of the changed field groups of a reg_change bit mask (CONTRACT 6.5).
create or replace function private.change_groups(p_fields int) returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(array_agg(g.name order by g.bit), '{}'::text[])
  from (values (0,'contact'),(1,'name'),(2,'nip'),(3,'address'),(4,'status'),(5,'legal'),(6,'structure'),(7,'dates'),(8,'detail')) as g(bit, name)
  where (p_fields & (1 << g.bit)) <> 0
$$;

create or replace function private.proposal_json(p crm.val_proposal) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'kind', p.kind, 'matchValue', p.match_value, 'confidence', p.confidence, 'groupKey', p.group_key,
    'status', p.status, 'members', to_jsonb(p.members), 'newMembers', to_jsonb(p.new_members),
    'decidedBy', p.decided_by, 'decidedAt', p.decided_at, 'note', p.note, 'networkId', p.network_id)
$$;

-- Entry ids selected by a BulkTarget ({entryIds} or {filter}); CR413 above p_max.
create or replace function private.resolve_target(p_target jsonb, p_me smallint, p_max int) returns int[]
language plpgsql stable set search_path = '' as $$
declare
  v_ids int[];
  v_where text;
begin
  if jsonb_typeof(p_target) is distinct from 'object' then
    perform private.raise_err('CR422', 'invalid_payload', 'target must be an object');
  end if;
  if p_target ? 'entryIds' then
    v_ids := private.int_array(p_target -> 'entryIds');
    if cardinality(v_ids) > 5000 then perform private.raise_err('CR413', 'too_many_rows', 'entryIds above 5000'); end if;
    select coalesce(array_agg(e.id order by e.id), '{}') into v_ids from crm.reg_entry e where e.id = any (v_ids);
  elsif p_target ? 'filter' then
    v_where := private.compile_filter(p_target -> 'filter', p_me);
    execute format('select coalesce(array_agg(s.id), ''{}'') from (select e.id from crm.reg_entry e left join crm.lead l on l.entry_id = e.id where %s order by e.id limit %s) s',
                   v_where, p_max + 1) into v_ids;
  else
    perform private.raise_err('CR422', 'invalid_payload', 'target needs entryIds or filter');
  end if;
  if cardinality(v_ids) > p_max then
    perform private.raise_err('CR413', 'too_many_rows', 'selection above ' || p_max || ' rows');
  end if;
  return v_ids;
end $$;

-- Writes one activity row (side-effect activities of status, owner, validation, dnc, task; user types come from activity_add).
create or replace function private.write_activity(
  p_entry int, p_type text, p_by smallint, p_body text default null, p_outcome text default null,
  p_status_from smallint default null, p_status_to smallint default null, p_task_id bigint default null,
  p_subject text default null
) returns bigint language sql set search_path = '' as $$
  insert into crm.activity (entry_id, type, outcome, subject, body, status_from, status_to, task_id, occurred_at, created_by)
  values (p_entry, p_type, p_outcome, p_subject, p_body, p_status_from, p_status_to, p_task_id, now(), p_by)
  returning id
$$;

-- Creates the lead row (default status) when the entry has none; CR404 for an unknown entry.
create or replace function private.ensure_lead(p_entry int, p_me smallint) returns void
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from crm.reg_entry where id = p_entry) then
    perform private.raise_err('CR404', 'not_found', 'entry ' || p_entry);
  end if;
  insert into crm.lead (entry_id, status_id, updated_by) values (p_entry, private.default_status(), p_me)
  on conflict (entry_id) do nothing;
end $$;

select private.apply_api_grants();
