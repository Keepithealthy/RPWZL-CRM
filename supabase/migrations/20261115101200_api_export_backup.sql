-- api: owner-only bulk export rows and the CRM backup / restore (CONTRACT 7; SPEC 8).

-- ExportRow[] for the entry ids, ordered by id. Detail blocks are parsed once per block, not once per entry.
create or replace function private.export_rows(p_ids int[]) returns jsonb
language sql stable set search_path = '' as $$
  with blocks as materialized (
    select b.block_no, b.recs::jsonb as j from crm.reg_detail_block b
    where b.block_no in (select distinct (x >> 5) from unnest(p_ids) x))
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id,
      'regKey', private.reg_key(e),
      'keyHash', private.hex16(e.key_hash),
      'kind', e.kind::text,
      'src', private.src_name(e.src),
      'name', e.name,
      'shortName', l.short_name,
      'nip', e.nip,
      'email', lr ->> 'email',
      'emails', (select coalesce(jsonb_agg(m), '[]'::jsonb) from (
                   select lower(c.value) as m from crm.lead_contact c
                     where c.entry_id = e.id and c.kind = 'email' and c.source = 'crm' and c.status <> 'invalid' and c.value is not null
                   union
                   select private.normalize_email(x) from unnest(coalesce(e.emails, array[e.email])) x
                     where x is not null and not exists (select 1 from crm.lead_contact c where c.entry_id = e.id and c.kind = 'email'
                       and c.source = 'register' and c.status = 'invalid' and c.value_norm = private.normalize_email(x))) q where m is not null),
      'tel', lr ->> 'tel',
      'mobile', lr ->> 'mobile',
      'phones', (select coalesce(jsonb_agg(distinct m), '[]'::jsonb) from (
                   select c.value as m from crm.lead_contact c
                     where c.entry_id = e.id and c.kind = 'phone' and c.source = 'crm' and c.status <> 'invalid' and c.value is not null
                   union
                   select x from jsonb_array_elements_text(case when jsonb_typeof(r.rec -> 'phones') = 'array' then r.rec -> 'phones' else '[]'::jsonb end) x
                   union select e.tel where e.tel is not null) q),
      'www', e.www,
      'miasto', e.miasto,
      'woj', lr ->> 'woj',
      'ulica', r.rec ->> 'ulica',
      'kod', e.kod,
      'forma', (select d.val from crm.reg_dict d where d.id = any (e.fv) and d.facet in ('p.forma', 'r.forma') limit 1),
      'formType', (select d.val from crm.reg_dict d where d.id = any (e.fv) and d.facet = 'p.formType' limit 1),
      'entityType', e.entity_type,
      'status', (select s.name from crm.lead_status s where s.id = coalesce(l.status_id, private.default_status())),
      'owner', (select m.display_name from crm.team_member m where m.id = l.owner_id),
      'tags', (select coalesce(jsonb_agg(t.name order by t.name), '[]'::jsonb) from crm.tag t where t.id = any (coalesce(l.tags, '{}'))),
      'validation', (lr ->> 'validation')::int,
      'nextStepAt', l.next_step_at,
      'lastContactAt', l.last_contact_at,
      'wpis', e.wpis,
      'stan', e.stan,
      'spec1', e.spec1,
      'nz', e.nz,
      'nk', e.nk,
      'qEmail', e.q_email,
      'dnc', coalesce(l.dnc, false),
      'inRegister', e.in_register,
      'firstImportedAt', (select coalesce(ir.finished_at, ir.started_at) from crm.import_run ir where ir.id = e.first_run)
    ) order by e.id), '[]'::jsonb)
  from crm.reg_entry e
  left join crm.lead l on l.entry_id = e.id
  left join blocks bl on bl.block_no = (e.id >> 5)
  cross join lateral (select bl.j -> e.id::text as rec) r
  cross join lateral (select private.lead_row(e, l) as lr) x
  where e.id = any (p_ids)
$$;

create or replace function api.export_begin(p_target jsonb, p_format text, p_options jsonb) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '50s' as $$
declare
  v_me     smallint := private.require_owner();
  v_opts   jsonb := coalesce(case when jsonb_typeof(p_options) = 'object' then p_options end, '{}'::jsonb);
  v_filter jsonb;
  v_total  int;
  v_id     int;
begin
  if p_format not in ('csv', 'customerio') then perform private.raise_err('CR422', 'invalid_payload', 'format must be csv|customerio'); end if;
  if jsonb_typeof(p_target) is distinct from 'object' then perform private.raise_err('CR422', 'invalid_payload', 'target must be an object'); end if;
  if p_target ? 'entryIds' then
    if cardinality(private.int_array(p_target -> 'entryIds')) > 5000 then
      perform private.raise_err('CR413', 'too_many_rows', 'entryIds above 5000');
    end if;
    v_filter := jsonb_build_object('entryIds', p_target -> 'entryIds', 'inRegister', 'all');
  elsif jsonb_typeof(p_target -> 'filter') = 'object' then
    v_filter := p_target -> 'filter';
  else
    perform private.raise_err('CR422', 'invalid_payload', 'target needs entryIds or filter');
  end if;
  -- the do-not-contact flag is excluded unless the owner explicitly includes it
  if coalesce((v_opts ->> 'includeDnc')::boolean, false) then
    v_filter := v_filter - 'dnc';
  else
    v_filter := v_filter || jsonb_build_object('dnc', 'exclude');
  end if;
  execute format('select count(*) from crm.reg_entry e left join crm.lead l on l.entry_id = e.id where %s',
                 private.compile_filter(v_filter, v_me)) into v_total;
  if v_total > 300000 then perform private.raise_err('CR413', 'too_many_rows', 'export above 300000 rows'); end if;
  insert into crm.export_log (format, target, options, total, created_by)
  values (p_format, jsonb_build_object('filter', v_filter), v_opts, v_total, v_me) returning id into v_id;
  return jsonb_build_object('exportId', v_id, 'total', v_total);
end $$;

create or replace function api.export_page(p_export_id int, p_offset int, p_limit int) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '50s' as $$
declare
  v_me  smallint := private.require_owner();
  v_log crm.export_log;
  v_ids int[];
begin
  if p_limit is not null and p_limit > 5000 then perform private.raise_err('CR413', 'too_many_rows', 'limit above 5000'); end if;
  if p_limit is null or p_limit < 1 or p_offset is null or p_offset < 0 then perform private.raise_err('CR422', 'invalid_payload', 'offset/limit'); end if;
  select * into v_log from crm.export_log where id = p_export_id;
  if not found then perform private.raise_err('CR404', 'not_found', 'export ' || p_export_id); end if;
  execute format('select coalesce(array_agg(s.id), ''{}'') from (select e.id from crm.reg_entry e left join crm.lead l on l.entry_id = e.id where %s order by e.id limit %s offset %s) s',
                 private.compile_filter(v_log.target -> 'filter', v_me), p_limit, p_offset) into v_ids;
  return private.export_rows(v_ids);
end $$;

-- Backup ---------------------------------------------------------------------------------------------------------------
create or replace function private.member_email(p_id smallint) returns text
language sql stable set search_path = '' as $$ select email from crm.team_member where id = p_id $$;

create or replace function private.backup_sql(p_table text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  return case p_table
    when 'team_member' then 'select jsonb_build_object(''id'', x.id, ''email'', x.email, ''displayName'', x.display_name, ''role'', x.role, ''phone'', x.phone, ''active'', x.active, ''createdAt'', x.created_at) from (select * from crm.team_member order by id offset $1 limit $2) x'
    when 'lead_status' then 'select jsonb_build_object(''id'', x.id, ''name'', x.name, ''color'', x.color, ''sort'', x.sort, ''stage'', x.stage, ''isDefault'', x.is_default, ''active'', x.active) from (select * from crm.lead_status order by id offset $1 limit $2) x'
    when 'tag' then 'select jsonb_build_object(''id'', x.id, ''name'', x.name, ''color'', x.color) from (select * from crm.tag order by id offset $1 limit $2) x'
    when 'app_setting' then 'select jsonb_build_object(''key'', x.key, ''value'', x.value) from (select * from crm.app_setting order by key offset $1 limit $2) x'
    when 'generic_domain' then 'select jsonb_build_object(''domain'', x.domain, ''kind'', x.kind, ''suggestion'', x.suggestion, ''source'', x.source) from (select * from crm.generic_domain order by domain offset $1 limit $2) x'
    when 'template' then 'select jsonb_build_object(''kind'', x.kind, ''name'', x.name, ''subject'', x.subject, ''body'', x.body, ''active'', x.active, ''sort'', x.sort) from (select * from crm.template order by id offset $1 limit $2) x'
    when 'list' then 'select jsonb_build_object(''name'', x.name, ''note'', x.note, ''createdBy'', private.member_email(x.created_by)) from (select * from crm.list order by id offset $1 limit $2) x'
    when 'list_member' then 'select jsonb_build_object(''list'', (select li.name from crm.list li where li.id = x.list_id), ''regKey'', private.reg_key(e), ''addedBy'', private.member_email(x.added_by), ''addedAt'', x.added_at) from (select * from crm.list_member order by list_id, entry_id offset $1 limit $2) x join crm.reg_entry e on e.id = x.entry_id'
    when 'saved_view' then 'select jsonb_build_object(''name'', x.name, ''scope'', x.scope, ''owner'', private.member_email(x.owner_id), ''filter'', x.filter, ''sort'', x.sort, ''columns'', to_jsonb(x.columns), ''note'', x.note, ''sortOrder'', x.sort_order) from (select * from crm.saved_view order by id offset $1 limit $2) x'
    when 'lead' then 'select jsonb_build_object(''regKey'', private.reg_key(e), ''status'', private.status_name(x.status_id), ''owner'', private.member_email(x.owner_id), ''tags'', (select coalesce(jsonb_agg(t.name order by t.name), ''[]''::jsonb) from crm.tag t where t.id = any (x.tags)), ''shortName'', x.short_name, ''dnc'', x.dnc, ''dncReason'', x.dnc_reason, ''dncAt'', x.dnc_at, ''dncBy'', private.member_email(x.dnc_by), ''validation'', x.validation, ''validationNote'', x.validation_note, ''checklist'', x.checklist, ''validatedAt'', x.validated_at, ''validatedBy'', private.member_email(x.validated_by), ''nextStepAt'', x.next_step_at, ''nextStepNote'', x.next_step_note, ''lastContactAt'', x.last_contact_at, ''version'', x.version) from (select * from crm.lead order by entry_id offset $1 limit $2) x join crm.reg_entry e on e.id = x.entry_id'
    when 'lead_contact' then 'select jsonb_build_object(''regKey'', private.reg_key(e), ''kind'', x.kind, ''value'', x.value, ''valueNorm'', x.value_norm, ''personName'', x.person_name, ''personRole'', x.person_role, ''status'', x.status, ''isPrimary'', x.is_primary, ''source'', x.source, ''note'', x.note) from (select * from crm.lead_contact order by id offset $1 limit $2) x join crm.reg_entry e on e.id = x.entry_id'
    when 'activity' then 'select jsonb_build_object(''regKey'', private.reg_key(e), ''type'', x.type, ''outcome'', x.outcome, ''contactValue'', x.contact_value, ''subject'', x.subject, ''body'', x.body, ''statusFrom'', (select ls.name from crm.lead_status ls where ls.id = x.status_from), ''statusTo'', (select ls.name from crm.lead_status ls where ls.id = x.status_to), ''occurredAt'', x.occurred_at, ''createdBy'', private.member_email(x.created_by)) from (select * from crm.activity order by id offset $1 limit $2) x join crm.reg_entry e on e.id = x.entry_id'
    when 'task' then 'select jsonb_build_object(''regKey'', (select private.reg_key(e) from crm.reg_entry e where e.id = x.entry_id), ''title'', x.title, ''note'', x.note, ''dueDate'', x.due_date, ''dueTime'', to_char(x.due_time, ''HH24:MI:SS''), ''assignee'', private.member_email(x.assignee_id), ''doneAt'', x.done_at, ''doneBy'', private.member_email(x.done_by), ''createdBy'', private.member_email(x.created_by), ''createdAt'', x.created_at) from (select * from crm.task order by id offset $1 limit $2) x'
    when 'network' then 'select jsonb_build_object(''name'', x.name, ''note'', x.note) from (select * from crm.network order by id offset $1 limit $2) x'
    when 'network_member' then 'select jsonb_build_object(''network'', (select n.name from crm.network n where n.id = x.network_id), ''accountKey'', x.account_key, ''addedBy'', private.member_email(x.added_by)) from (select * from crm.network_member order by account_key offset $1 limit $2) x'
    when 'val_proposal' then 'select jsonb_build_object(''kind'', x.kind, ''matchValue'', x.match_value, ''confidence'', x.confidence, ''groupKey'', x.group_key, ''members'', to_jsonb(x.members), ''decidedMembers'', to_jsonb(x.decided_members), ''newMembers'', to_jsonb(x.new_members), ''status'', x.status, ''decidedBy'', private.member_email(x.decided_by), ''decidedAt'', x.decided_at, ''note'', x.note, ''network'', (select n.name from crm.network n where n.id = x.network_id)) from (select * from crm.val_proposal order by id offset $1 limit $2) x'
    when 'val_decision' then 'select jsonb_build_object(''keyHash'', private.hex16(x.key_hash), ''action'', x.action, ''accountKey'', x.account_key, ''note'', x.note, ''decidedBy'', private.member_email(x.decided_by), ''decidedAt'', x.decided_at) from (select * from crm.val_decision order by id offset $1 limit $2) x'
    else null end;
end $$;

create or replace function api.backup_export(p_table text, p_offset int, p_limit int) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '50s' as $$
declare
  v_me  smallint := private.require_owner();
  v_sql text := private.backup_sql(p_table);
  v_res jsonb;
begin
  if v_sql is null then perform private.raise_err('CR422', 'invalid_payload', 'unknown backup table ' || left(coalesce(p_table, 'null'), 40)); end if;
  if p_limit is not null and p_limit > 5000 then perform private.raise_err('CR413', 'too_many_rows', 'limit above 5000'); end if;
  if p_limit is null or p_limit < 1 or p_offset is null or p_offset < 0 then perform private.raise_err('CR422', 'invalid_payload', 'offset/limit'); end if;
  execute 'select coalesce(jsonb_agg(r), ''[]''::jsonb) from (' || v_sql || ') t(r)' using p_offset, p_limit into v_res;
  return v_res;
end $$;

-- Merge-mode restore: inserts rows whose natural key is absent; never overwrites. Rows that refer to a register entry
-- (regKey) or member that does not exist are counted as unresolved (import the register first).
create or replace function api.backup_restore(p_table text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '55s' as $$
declare
  v_me    smallint := private.require_owner();
  v_total int;
  v_cand  int := 0;
  v_ins   int := 0;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then perform private.raise_err('CR422', 'invalid_payload', 'rows must be an array'); end if;
  v_total := jsonb_array_length(p_rows);
  if v_total > 5000 then perform private.raise_err('CR413', 'too_many_rows', 'more than 5000 rows'); end if;

  if p_table = 'team_member' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x(email text) where x.email is not null;
    -- SEC-05: a file never creates owners; restored people come back as members and the owner promotes them in Użytkownicy
    insert into crm.team_member (email, display_name, role, phone, active)
    select lower(x.email), x."displayName", 'member', x.phone, coalesce(x.active, true)
    from jsonb_to_recordset(p_rows) as x(email text, "displayName" text, role text, phone text, active boolean)
    where x.email is not null and x.role in ('owner', 'member') and coalesce(x."displayName", '') <> ''
    on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'lead_status' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x(name text) where x.name is not null;
    insert into crm.lead_status (name, color, sort, stage, is_default, active)
    select x.name, coalesce(x.color, '#64748b'), coalesce(x.sort, 100), coalesce(x.stage, 'open'), false, coalesce(x.active, true)
    from jsonb_to_recordset(p_rows) as x(name text, color text, sort smallint, stage text, active boolean)
    where x.name is not null and not exists (select 1 from crm.lead_status s where lower(s.name) = lower(x.name))
    on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'tag' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x(name text) where x.name is not null;
    insert into crm.tag (name, color)
    select x.name, coalesce(x.color, '#64748b') from jsonb_to_recordset(p_rows) as x(name text, color text)
    where x.name is not null and not exists (select 1 from crm.tag t where lower(t.name) = lower(x.name))
    on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'app_setting' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x(key text) where x.key is not null;
    insert into crm.app_setting (key, value)
    select x.key, x.value from jsonb_to_recordset(p_rows) as x(key text, value jsonb) where x.key is not null and x.value is not null
      -- SEC-05: only the known keys (setting_set's list); every one of them is seeded, so a restore never overwrites a value
      and x.key in ('ui.staleDays', 'val.minConfidence', 'val.params', 'sms.diacritics', 'history.keepRuns', 'export.defaults')
    on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'generic_domain' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x(domain text) where x.domain is not null;
    insert into crm.generic_domain (domain, kind, suggestion, source)
    select lower(x.domain), x.kind, x.suggestion, coalesce(x.source, 'owner')
    from jsonb_to_recordset(p_rows) as x(domain text, kind text, suggestion text, source text)
    where x.domain is not null and x.kind in ('free', 'generic', 'typo', 'social') on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'template' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x(name text) where x.name is not null;
    insert into crm.template (kind, name, subject, body, active, sort)
    select x.kind, x.name, x.subject, x.body, coalesce(x.active, true), coalesce(x.sort, 100)
    from jsonb_to_recordset(p_rows) as x(kind text, name text, subject text, body text, active boolean, sort smallint)
    where x.name is not null and x.body is not null and x.kind in ('email', 'sms', 'call') on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'list' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x(name text) where x.name is not null;
    insert into crm.list (name, note, created_by)
    select x.name, x.note, (select m.id from crm.team_member m where m.email = lower(x."createdBy"))
    from jsonb_to_recordset(p_rows) as x(name text, note text, "createdBy" text)
    where x.name is not null and not exists (select 1 from crm.list l where lower(l.name) = lower(x.name)) on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'list_member' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x("regKey" text, list text)
      where private.entry_id_by_reg_key(x."regKey") is not null and exists (select 1 from crm.list l where l.name = x.list);
    insert into crm.list_member (list_id, entry_id, added_by, added_at)
    select l.id, private.entry_id_by_reg_key(x."regKey"), (select m.id from crm.team_member m where m.email = lower(x."addedBy")), coalesce(x."addedAt", now())
    from jsonb_to_recordset(p_rows) as x("regKey" text, list text, "addedBy" text, "addedAt" timestamptz)
    join crm.list l on l.name = x.list
    where private.entry_id_by_reg_key(x."regKey") is not null on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'saved_view' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x(name text, scope text, owner text)
      where x.name is not null and x.scope in ('system', 'shared', 'private') and (x.scope = 'system' or exists (select 1 from crm.team_member m where m.email = lower(x.owner)));
    insert into crm.saved_view (name, scope, owner_id, filter, sort, columns, note, sort_order)
    select x.name, x.scope, (select m.id from crm.team_member m where m.email = lower(x.owner) and x.scope <> 'system'), x.filter, x.sort,
           (select array_agg(c) from jsonb_array_elements_text(case when jsonb_typeof(x.columns) = 'array' then x.columns else '[]'::jsonb end) c),
           x.note, coalesce(x."sortOrder", 100)
    from jsonb_to_recordset(p_rows) as x(name text, scope text, owner text, filter jsonb, sort jsonb, columns jsonb, note text, "sortOrder" smallint)
    where x.name is not null and x.filter is not null and x.scope in ('system', 'shared', 'private')
      and (x.scope = 'system' or exists (select 1 from crm.team_member m where m.email = lower(x.owner)))
    on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'lead' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x("regKey" text) where private.entry_id_by_reg_key(x."regKey") is not null;
    insert into crm.lead (entry_id, status_id, owner_id, tags, short_name, dnc, dnc_reason, dnc_at, dnc_by, validation, validation_note,
                          checklist, validated_at, validated_by, next_step_at, next_step_note, last_contact_at)
    select private.entry_id_by_reg_key(x."regKey"),
           coalesce((select s.id from crm.lead_status s where lower(s.name) = lower(x.status) order by s.active desc limit 1), private.default_status()),
           (select m.id from crm.team_member m where m.email = lower(x.owner)),
           coalesce((select array_agg(t.id order by t.id) from crm.tag t where t.name in (select jsonb_array_elements_text(case when jsonb_typeof(x.tags) = 'array' then x.tags else '[]'::jsonb end))), '{}'),
           x."shortName", coalesce(x.dnc, false), x."dncReason", x."dncAt", (select m.id from crm.team_member m where m.email = lower(x."dncBy")),
           x.validation, x."validationNote", x.checklist, x."validatedAt", (select m.id from crm.team_member m where m.email = lower(x."validatedBy")),
           x."nextStepAt", x."nextStepNote", x."lastContactAt"
    from jsonb_to_recordset(p_rows) as x("regKey" text, status text, owner text, tags jsonb, "shortName" text, dnc boolean, "dncReason" text,
         "dncAt" timestamptz, "dncBy" text, validation smallint, "validationNote" text, checklist jsonb, "validatedAt" timestamptz,
         "validatedBy" text, "nextStepAt" date, "nextStepNote" text, "lastContactAt" timestamptz)
    where private.entry_id_by_reg_key(x."regKey") is not null on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'lead_contact' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x("regKey" text) where private.entry_id_by_reg_key(x."regKey") is not null;
    insert into crm.lead_contact (entry_id, kind, value, value_norm, person_name, person_role, status, is_primary, source, note)
    select z.entry_id, z.kind, z.value, z."valueNorm", z."personName", z."personRole", coalesce(z.status, 'unknown'), coalesce(z."isPrimary", false),
           coalesce(z.source, 'crm'), z.note
    from (select private.entry_id_by_reg_key(x."regKey") as entry_id, x.* from jsonb_to_recordset(p_rows) as x(
            "regKey" text, kind text, value text, "valueNorm" text, "personName" text, "personRole" text, status text, "isPrimary" boolean,
            source text, note text)) z
    where z.entry_id is not null and z.kind in ('email', 'phone', 'www', 'person')
      and not exists (select 1 from crm.lead_contact c where c.entry_id = z.entry_id and c.kind = z.kind
                      and coalesce(c.value_norm, '') = coalesce(z."valueNorm", '') and coalesce(c.person_name, '') = coalesce(z."personName", '')
                      and c.source = coalesce(z.source, 'crm'))
    on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'activity' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x("regKey" text, "createdBy" text)
      where private.entry_id_by_reg_key(x."regKey") is not null and exists (select 1 from crm.team_member m where m.email = lower(x."createdBy"));
    insert into crm.activity (entry_id, type, outcome, contact_value, subject, body, status_from, status_to, occurred_at, created_by)
    select z.entry_id, z.type, z.outcome, z."contactValue", z.subject, z.body,
           (select s.id from crm.lead_status s where lower(s.name) = lower(z."statusFrom") order by s.active desc limit 1),
           (select s.id from crm.lead_status s where lower(s.name) = lower(z."statusTo") order by s.active desc limit 1),
           coalesce(z."occurredAt", now()), z.created_by
    from (select private.entry_id_by_reg_key(x."regKey") as entry_id, (select m.id from crm.team_member m where m.email = lower(x."createdBy")) as created_by, x.*
          from jsonb_to_recordset(p_rows) as x("regKey" text, type text, outcome text, "contactValue" text, subject text, body text,
            "statusFrom" text, "statusTo" text, "occurredAt" timestamptz, "createdBy" text)) z
    where z.entry_id is not null and z.created_by is not null
      and not exists (select 1 from crm.activity a where a.entry_id = z.entry_id and a.type = z.type and a.occurred_at = z."occurredAt"
                      and a.created_by = z.created_by and coalesce(a.body, '') = coalesce(z.body, '') and coalesce(a.subject, '') = coalesce(z.subject, ''))
    on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'task' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x("regKey" text, assignee text)
      where (x."regKey" is null or private.entry_id_by_reg_key(x."regKey") is not null)
        and exists (select 1 from crm.team_member m where m.email = lower(x.assignee));
    insert into crm.task (entry_id, title, note, due_date, due_time, assignee_id, done_at, done_by, created_by, created_at)
    select z.entry_id, z.title, z.note, z."dueDate", z."dueTime", z.assignee_id, z."doneAt", (select m.id from crm.team_member m where m.email = lower(z."doneBy")),
           (select m.id from crm.team_member m where m.email = lower(z."createdBy")), coalesce(z."createdAt", now())
    from (select private.entry_id_by_reg_key(x."regKey") as entry_id, (select m.id from crm.team_member m where m.email = lower(x.assignee)) as assignee_id, x.*
          from jsonb_to_recordset(p_rows) as x("regKey" text, title text, note text, "dueDate" date, "dueTime" time, assignee text, "doneAt" timestamptz,
            "doneBy" text, "createdBy" text, "createdAt" timestamptz)) z
    where (z."regKey" is null or z.entry_id is not null) and z.assignee_id is not null and z.title is not null and z."dueDate" is not null
      and not exists (select 1 from crm.task t where coalesce(t.entry_id, 0) = coalesce(z.entry_id, 0) and t.title = z.title
                      and t.due_date = z."dueDate" and t.assignee_id = z.assignee_id)
    on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'network' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x(name text) where x.name is not null;
    insert into crm.network (name, note)
    select x.name, x.note from jsonb_to_recordset(p_rows) as x(name text, note text)
    where x.name is not null and not exists (select 1 from crm.network n where lower(n.name) = lower(x.name)) on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'network_member' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x(network text, "accountKey" text)
      where x."accountKey" is not null and exists (select 1 from crm.network n where n.name = x.network);
    insert into crm.network_member (account_key, network_id, added_by)
    select x."accountKey", n.id, (select m.id from crm.team_member m where m.email = lower(x."addedBy"))
    from jsonb_to_recordset(p_rows) as x(network text, "accountKey" text, "addedBy" text) join crm.network n on n.name = x.network
    where x."accountKey" is not null on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'val_proposal' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x(kind text, "matchValue" text) where x.kind is not null and x."matchValue" is not null;
    insert into crm.val_proposal (kind, match_value, confidence, group_key, members, decided_members, new_members, status, decided_by, decided_at, note, network_id)
    select x.kind, x."matchValue", x.confidence, x."groupKey", x.members, x."decidedMembers", coalesce(x."newMembers", '{}'), coalesce(x.status, 0),
           (select m.id from crm.team_member m where m.email = lower(x."decidedBy")), x."decidedAt", x.note,
           (select n.id from crm.network n where n.name = x.network)
    from jsonb_to_recordset(p_rows) as x(kind text, "matchValue" text, confidence smallint, "groupKey" text, members text[], "decidedMembers" text[],
         "newMembers" text[], status smallint, "decidedBy" text, "decidedAt" timestamptz, note text, network text)
    where x.kind is not null and x."matchValue" is not null and x.members is not null on conflict do nothing;
    get diagnostics v_ins = row_count;
  elsif p_table = 'val_decision' then
    select count(*) into v_cand from jsonb_to_recordset(p_rows) as x("keyHash" text) where x."keyHash" ~ '^[0-9a-f]{16}$';
    insert into crm.val_decision (action, key_hash, account_key, note, decided_by, decided_at)
    select x.action, private.hash_from_hex(x."keyHash"), case when x.action = 'attach' then x."accountKey" end, x.note, (select m.id from crm.team_member m where m.email = lower(x."decidedBy")),
           coalesce(x."decidedAt", now())
    from jsonb_to_recordset(p_rows) as x("keyHash" text, action text, "accountKey" text, note text, "decidedBy" text, "decidedAt" timestamptz)
    where x."keyHash" ~ '^[0-9a-f]{16}$'
      and (x.action = 'detach' or (x.action = 'attach' and x."accountKey" ~ '^(n:[0-9]{10}|e:[0-9a-f]{16})$'))
    on conflict do nothing;
    get diagnostics v_ins = row_count;
  else
    perform private.raise_err('CR422', 'invalid_payload', 'unknown backup table ' || left(coalesce(p_table, 'null'), 40));
  end if;
  return jsonb_build_object('inserted', v_ins, 'skipped', greatest(v_cand - v_ins, 0), 'unresolved', greatest(v_total - v_cand, 0));
exception when invalid_text_representation or invalid_datetime_format or numeric_value_out_of_range or datetime_field_overflow then
  perform private.raise_err('CR422', 'invalid_payload', 'a backup row has a field of the wrong type');
  return null;
when check_violation or foreign_key_violation or not_null_violation or string_data_right_truncation then
  -- SEC-05: a value the table refuses (unknown activity type, validation out of range ...) is a payload error, not a raw one
  perform private.raise_err('CR422', 'invalid_payload', 'a backup row has a value the table does not accept (' || sqlerrm || ')');
  return null;
end $$;

select private.apply_api_grants();
