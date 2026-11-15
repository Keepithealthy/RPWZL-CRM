-- api: session, reference data, leads list/count/facets, record card, timeline (CONTRACT 3, 4).

create or replace function private.status_json(s crm.lead_status) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'color', s.color, 'sort', s.sort, 'stage', s.stage,
                            'isDefault', s.is_default, 'active', s.active)
$$;

create or replace function private.tag_json(t crm.tag) returns jsonb
language sql stable set search_path = '' as
$$ select jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color) $$;

create or replace function private.member_public_json(m crm.team_member) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'displayName', m.display_name, 'role', m.role, 'active', m.active,
                            'phone', m.phone, 'email', m.email)
$$;

create or replace function private.view_json(v crm.saved_view) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', v.id, 'name', v.name, 'scope', v.scope, 'ownerId', v.owner_id, 'filter', v.filter,
                            'sort', v.sort, 'columns', to_jsonb(v.columns), 'note', v.note, 'sortOrder', v.sort_order)
$$;

create or replace function private.list_json(l crm.list) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', l.id, 'name', l.name, 'note', l.note,
    'members', (select count(*) from crm.list_member lm where lm.list_id = l.id),
    'createdBy', l.created_by, 'updatedAt', l.updated_at)
$$;

create or replace function private.public_settings() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'staleDays', private.setting_int('ui.staleDays', 35),
    'valMinConfidence', private.min_conf(),
    'smsDiacritics', coalesce((select value #>> '{}' from crm.app_setting where key = 'sms.diacritics'), 'keep'))
$$;

create or replace function api.me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  return (select jsonb_build_object('memberId', m.id, 'email', m.email, 'displayName', m.display_name,
                                    'role', m.role, 'phone', m.phone)
          from crm.team_member m where m.id = v_me);
end $$;

create or replace function api.ref_data() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  return jsonb_build_object(
    'me', api.me(),
    'statuses', (select coalesce(jsonb_agg(private.status_json(s) order by s.sort, s.id), '[]') from crm.lead_status s),
    'tags', (select coalesce(jsonb_agg(private.tag_json(t) order by lower(t.name)), '[]') from crm.tag t),
    'members', (select coalesce(jsonb_agg(private.member_public_json(m) order by m.display_name), '[]') from crm.team_member m),
    'views', (select coalesce(jsonb_agg(private.view_json(v) order by (v.scope <> 'system'), v.sort_order, v.name), '[]')
              from crm.saved_view v where v.scope in ('system', 'shared') or v.owner_id = v_me),
    'lists', (select coalesce(jsonb_agg(private.list_json(l) order by lower(l.name)), '[]') from crm.list l),
    'lastImport', (select jsonb_build_object('id', r.id, 'reportDate', r.report_date, 'finishedAt', r.finished_at)
                   from crm.import_run r where r.status = 'applied' order by r.id desc limit 1),
    'settings', private.public_settings());
end $$;

create or replace function api.dict(p_facets text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('facet', d.facet, 'val', d.val, 'label', d.label) order by d.facet, d.val), '[]')
          from crm.reg_dict d where d.facet = any (coalesce(p_facets, '{}')) and d.facet <> 'org');
end $$;

create or replace function api.db_usage() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_owner();
begin
  return jsonb_build_object(
    'bytes', pg_database_size(current_database()),
    'limitBytes', 524288000,
    'dictValues', (select count(*) from crm.reg_dict),
    'dictLimit', 32767,
    'tables', (select coalesce(jsonb_agg(jsonb_build_object('name', t.relname, 'bytes', t.sz) order by t.sz desc), '[]')
               from (select c.relname::text as relname, pg_total_relation_size(c.oid) as sz
                     from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'crm' and c.relkind = 'r'
                     order by pg_total_relation_size(c.oid) desc limit 10) t));
end $$;

-- Leads list ---------------------------------------------------------------------------------------------------------
create or replace function api.leads_search(p_filter jsonb, p_sort jsonb, p_offset int, p_limit int) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '50s' as $$
declare
  v_me    smallint := private.require_member();
  v_where text;
  v_ids   int[];
begin
  if p_limit is not null and p_limit > 200 then
    perform private.raise_err('CR413', 'too_many_rows', 'limit above 200');
  end if;
  if p_limit is null or p_limit < 1 or p_offset is null or p_offset < 0 then
    perform private.raise_err('CR422', 'invalid_payload', 'p_offset >= 0 and 1 <= p_limit <= 200 required');
  end if;
  v_where := private.compile_filter(p_filter, v_me);
  execute format(
    'select coalesce(array_agg(s.id), ''{}'') from (select e.id from crm.reg_entry e left join crm.lead l on l.entry_id = e.id where %s order by %s limit %s offset %s) s',
    v_where, private.sort_clause(p_sort), p_limit, p_offset) into v_ids;
  return jsonb_build_object('rows', private.lead_rows(v_ids));
end $$;

create or replace function api.leads_count(p_filter jsonb) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '50s' as $$
declare
  v_me    smallint := private.require_member();
  v_where text := private.compile_filter(p_filter, v_me);
  v_res   jsonb;
begin
  execute format(
    'select jsonb_build_object(''total'', count(*), ''email'', count(*) filter (where (e.cflags & 1) = 1), ''tel'', count(*) filter (where (e.cflags & 2) = 2), ''www'', count(*) filter (where (e.cflags & 4) = 4), ''nip'', count(*) filter (where (e.cflags & 8) = 8), ''mobile'', count(*) filter (where (e.cflags & 16) = 16)) from crm.reg_entry e left join crm.lead l on l.entry_id = e.id where %s',
    v_where) into v_res;
  return v_res;
end $$;

-- Faceted counts: each facet's counts ignore that facet's own selection (CONTRACT 4).
create or replace function api.leads_facets(p_filter jsonb, p_facets text[]) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '50s' as $$
declare
  v_me     smallint := private.require_member();
  v_sel    jsonb := coalesce(p_filter -> 'sel', '{}'::jsonb);
  v_plain  text[] := '{}';
  v_facet  text;
  v_res    jsonb := '{}'::jsonb;
  v_part   jsonb;
begin
  foreach v_facet in array coalesce(p_facets, '{}') loop
    if jsonb_typeof(v_sel -> v_facet) = 'array' and jsonb_array_length(v_sel -> v_facet) > 0 then
      -- selected facet: its own predicate is removed, so it gets a pass of its own
      execute format(
        'select coalesce(jsonb_object_agg(%L, c.arr), ''{}'') from (select coalesce(jsonb_agg(jsonb_build_array(x.val, x.n) order by x.n desc, x.val), ''[]'') as arr from (select d.val, count(*) as n from (select unnest(e.fv) as id from crm.reg_entry e left join crm.lead l on l.entry_id = e.id where %s) u join crm.reg_dict d on d.id = u.id where d.facet = %L group by d.val) x) c',
        v_facet, private.compile_filter(p_filter, v_me, v_facet), v_facet) into v_part;
      v_res := v_res || v_part;
    else
      v_plain := v_plain || v_facet;
    end if;
  end loop;
  if cardinality(v_plain) > 0 then
    execute format(
      'select coalesce(jsonb_object_agg(f.facet, f.arr), ''{}'') from (select x.facet, jsonb_agg(jsonb_build_array(x.val, x.n) order by x.n desc, x.val) as arr from (select d.facet, d.val, count(*) as n from (select unnest(e.fv) as id from crm.reg_entry e left join crm.lead l on l.entry_id = e.id where %s) u join crm.reg_dict d on d.id = u.id where d.facet = any (%L::text[]) group by d.facet, d.val) x group by x.facet) f',
      private.compile_filter(p_filter, v_me), v_plain::text) into v_part;
    v_res := v_res || v_part;
  end if;
  return v_res;
end $$;

-- Record card ---------------------------------------------------------------------------------------------------------
create or replace function api.lead_get(p_entry_id int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_member();
  e    crm.reg_entry;
  l    crm.lead;
  v_net jsonb;
begin
  select * into e from crm.reg_entry where id = p_entry_id;
  if not found then perform private.raise_err('CR404', 'not_found', 'entry ' || p_entry_id); end if;
  select * into l from crm.lead where entry_id = e.id;
  select jsonb_build_object('id', n.id, 'name', n.name,
                            'members', (select count(*) from crm.network_member x where x.network_id = n.id))
    into v_net from crm.network_member nm join crm.network n on n.id = nm.network_id where nm.account_key = e.account_key;

  return jsonb_build_object(
    'row', private.lead_row(e, l),
    'regKey', private.reg_key(e),
    'ks', e.ks,
    'org', (select d.val from crm.reg_dict d where d.id = e.reg_org),
    'kod', e.kod,
    'facets', (select coalesce(jsonb_object_agg(g.facet, g.vals), '{}'::jsonb)
               from (select d.facet, jsonb_agg(d.val order by d.val) as vals from crm.reg_dict d
                     where d.id = any (e.fv) and d.facet <> 'org' group by d.facet) g),
    'rec', (select (b.recs::jsonb) -> e.id::text from crm.reg_detail_block b where b.block_no = (e.id >> 5)),
    'lead', case when l.entry_id is null then null else jsonb_build_object(
        'shortName', l.short_name, 'dncReason', l.dnc_reason, 'dncAt', l.dnc_at,
        'validationNote', l.validation_note, 'checklist', l.checklist,
        'validatedAt', l.validated_at, 'validatedBy', l.validated_by,
        'regChangedAfterValidation', l.validated_at is not null and exists (
           select 1 from crm.reg_change c join crm.import_run r on r.id = c.run_id
           where c.entry_id = e.id and (c.fields & 1) <> 0 and r.finished_at > l.validated_at)) end,
    'contacts', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'value', c.value,
                   'personName', c.person_name, 'personRole', c.person_role, 'status', c.status,
                   'isPrimary', c.is_primary, 'source', c.source, 'note', c.note, 'updatedAt', c.updated_at) order by c.id), '[]')
                 from crm.lead_contact c where c.entry_id = e.id),
    'account', private.lead_rows((select coalesce(array_agg(s.id), '{}') from
                 (select x.id from crm.reg_entry x where x.account_key = e.account_key and x.id <> e.id order by x.id limit 50) s)),
    'network', v_net,
    'proposals', (select coalesce(jsonb_agg(private.proposal_json(p) order by p.status, p.confidence desc, p.id), '[]')
                  from crm.val_proposal p where p.members @> array[e.account_key] and p.status in (0, 1, 2)),
    'lists', (select coalesce(jsonb_agg(jsonb_build_object('id', li.id, 'name', li.name) order by lower(li.name)), '[]')
              from crm.list_member lm join crm.list li on li.id = lm.list_id where lm.entry_id = e.id),
    'phoneOwners', (select coalesce(jsonb_object_agg(t.n::text, t.cnt), '{}'::jsonb)
                    from (select n, (select count(distinct x.account_key) from crm.reg_entry x where x.nums @> array[n]) as cnt
                          from unnest(coalesce(e.nums, '{}'::int[])) as n) t),
    'firstRun', (select jsonb_build_object('id', r.id, 'reportDate', r.report_date) from crm.import_run r where r.id = e.first_run),
    'lastChange', (select jsonb_build_object('runId', r.id, 'reportDate', r.report_date) from crm.import_run r where r.id = e.last_change_run));
end $$;

create or replace function api.lead_timeline(p_entry_id int, p_scope text, p_before timestamptz, p_limit int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me     smallint := private.require_member();
  v_owner  boolean := private.is_owner(v_me);
  v_ids    int[];
  v_before timestamptz := coalesce(p_before, 'infinity'::timestamptz);
  v_acc    text;
begin
  if p_limit is not null and p_limit > 100 then perform private.raise_err('CR413', 'too_many_rows', 'limit above 100'); end if;
  if p_limit is null or p_limit < 1 or p_scope not in ('entry', 'account') then
    perform private.raise_err('CR422', 'invalid_payload', 'scope entry|account and 1 <= limit <= 100 required');
  end if;
  select account_key into v_acc from crm.reg_entry where id = p_entry_id;
  if v_acc is null then perform private.raise_err('CR404', 'not_found', 'entry ' || p_entry_id); end if;
  if p_scope = 'entry' then v_ids := array[p_entry_id];
  else select array_agg(id) into v_ids from crm.reg_entry where account_key = v_acc; end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'at', i.at, 'entryId', i.entry_id, 'source', i.source, 'type', i.type, 'outcome', i.outcome,
        'contactValue', i.contact_value, 'subject', i.subject, 'body', i.body, 'statusFrom', i.status_from,
        'statusTo', i.status_to, 'fields', to_jsonb(i.fields), 'old', i.old, 'byId', i.by_id, 'editable', i.editable)
      order by i.at desc, i.seq desc, i.id desc), '[]')
    from (
      select * from (
        select 'a:' || a.id as id, a.occurred_at as at, a.entry_id, 'activity'::text as source, a.type::text as type,
               a.outcome, a.contact_value, a.subject, a.body, a.status_from, a.status_to, null::text[] as fields,
               null::jsonb as old, a.created_by as by_id,
               (a.type in ('call', 'sms', 'email', 'meeting', 'note')
                and (v_owner or (a.created_by = v_me and a.created_at > now() - interval '24 hours'))) as editable,
               a.id as seq
        from crm.activity a
        where a.entry_id = any (v_ids) and a.type <> 'task' and a.occurred_at < v_before
        order by a.occurred_at desc limit p_limit
      ) x1
      union all
      select * from (
        select 'c:' || c.run_id || ':' || c.entry_id, coalesce(r.finished_at, r.started_at), c.entry_id, 'register',
               case c.change when 2 then 'register_returned' else 'register_changed' end,
               null, null, null, null, null::smallint, null::smallint, private.change_groups(c.fields), c.old, null::smallint, false, 0::bigint
        from crm.reg_change c join crm.import_run r on r.id = c.run_id
        where c.entry_id = any (v_ids) and coalesce(r.finished_at, r.started_at) < v_before
        order by coalesce(r.finished_at, r.started_at) desc limit p_limit
      ) x2
      union all
      select * from (
        select 'c:' || e.first_run || ':' || e.id, coalesce(r.finished_at, r.started_at), e.id, 'register', 'register_new',
               null, null, null, null, null::smallint, null::smallint, null::text[], null::jsonb, null::smallint, false, 0::bigint
        from crm.reg_entry e join crm.import_run r on r.id = e.first_run
        where e.id = any (v_ids) and coalesce(r.finished_at, r.started_at) < v_before
        order by coalesce(r.finished_at, r.started_at) desc limit p_limit
      ) x3
      union all
      select * from (
        select 'c:' || e.gone_run || ':' || e.id, coalesce(r.finished_at, r.started_at), e.id, 'register', 'register_gone',
               null, null, null, null, null::smallint, null::smallint, null::text[], null::jsonb, null::smallint, false, 0::bigint
        from crm.reg_entry e join crm.import_run r on r.id = e.gone_run
        where e.id = any (v_ids) and not e.in_register and coalesce(r.finished_at, r.started_at) < v_before
        order by coalesce(r.finished_at, r.started_at) desc limit p_limit
      ) x4
      union all
      select * from (
        select 't:' || t.id, t.done_at, t.entry_id, 'task', 'task',
               null, null, t.title, t.note, null::smallint, null::smallint, null::text[], null::jsonb, t.done_by, false, 0::bigint
        from crm.task t
        where t.entry_id = any (v_ids) and t.done_at is not null and t.done_at < v_before
        order by t.done_at desc limit p_limit
      ) x5
      order by at desc, seq desc, id desc limit p_limit
    ) i
  );
end $$;

select private.apply_api_grants();
