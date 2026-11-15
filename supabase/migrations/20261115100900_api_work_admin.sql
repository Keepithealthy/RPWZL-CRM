-- api: tasks, "Dziś", templates, lists, views, tags, statuses, members, settings, generic domains (CONTRACT 5).

-- Tasks ----------------------------------------------------------------------------------------------------------------
create or replace function private.task_json(t crm.task) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'entryId', t.entry_id,
    'entryName', (select e.name from crm.reg_entry e where e.id = t.entry_id),
    'title', t.title, 'note', t.note, 'dueDate', t.due_date, 'dueTime', to_char(t.due_time, 'HH24:MI'),
    'assigneeId', t.assignee_id, 'doneAt', t.done_at, 'createdBy', t.created_by, 'createdAt', t.created_at)
$$;

create or replace function api.tasks_list(p_scope text, p_open boolean, p_due_to date, p_entry_id int, p_offset int, p_limit int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  if p_limit is not null and p_limit > 200 then perform private.raise_err('CR413', 'too_many_rows', 'limit above 200'); end if;
  if p_scope not in ('mine', 'all') or p_limit is null or p_limit < 1 or p_offset is null or p_offset < 0 then
    perform private.raise_err('CR422', 'invalid_payload', 'scope mine|all, offset >= 0, 1 <= limit <= 200');
  end if;
  return (select coalesce(jsonb_agg(private.task_json(t) order by
            case when p_open then t.due_date end asc, case when p_open then t.due_time end asc nulls last,
            case when not p_open then t.done_at end desc, t.id), '[]')
          from (select * from crm.task x
                where (p_scope = 'all' or x.assignee_id = v_me)
                  and ((p_open and x.done_at is null) or (not p_open and x.done_at is not null))
                  and (p_due_to is null or x.due_date <= p_due_to)
                  and (p_entry_id is null or x.entry_id = p_entry_id)
                order by case when p_open then x.due_date end asc, case when p_open then x.due_time end asc nulls last,
                         case when not p_open then x.done_at end desc, x.id
                limit p_limit offset p_offset) t);
end $$;

create or replace function api.task_upsert(p_task jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me  smallint := private.require_member();
  t     crm.task;
  v_title text;
  v_assignee smallint;
  v_entry int;
begin
  if jsonb_typeof(p_task) is distinct from 'object' then perform private.raise_err('CR422', 'invalid_payload', 'task must be an object'); end if;
  if p_task ->> 'id' is not null then
    select * into t from crm.task where id = (p_task ->> 'id')::bigint for update;
    if not found then perform private.raise_err('CR404', 'not_found', 'task ' || (p_task ->> 'id')); end if;
  end if;
  v_title := coalesce(private.patch_text(p_task, 'title', 300), t.title);
  if v_title is null then perform private.raise_err('CR422', 'invalid_payload', 'title is required'); end if;
  if p_task ->> 'dueDate' is null and t.id is null then perform private.raise_err('CR422', 'invalid_payload', 'dueDate is required'); end if;
  v_assignee := coalesce((p_task ->> 'assigneeId')::smallint, t.assignee_id, v_me);
  perform private.check_member(v_assignee, 'assigneeId');
  v_entry := case when p_task ? 'entryId' then (p_task ->> 'entryId')::int else t.entry_id end;
  if v_entry is not null and not exists (select 1 from crm.reg_entry where id = v_entry) then
    perform private.raise_err('CR404', 'not_found', 'entry ' || v_entry);
  end if;
  if t.id is null then
    insert into crm.task (entry_id, title, note, due_date, due_time, assignee_id, created_by, updated_by)
    values (v_entry, v_title, private.patch_text(p_task, 'note', 2000), (p_task ->> 'dueDate')::date,
            (p_task ->> 'dueTime')::time, v_assignee, v_me, v_me)
    returning * into t;
  else
    update crm.task set entry_id = v_entry, title = v_title,
      note = case when p_task ? 'note' then private.patch_text(p_task, 'note', 2000) else note end,
      due_date = coalesce((p_task ->> 'dueDate')::date, due_date),
      due_time = case when p_task ? 'dueTime' then (p_task ->> 'dueTime')::time else due_time end,
      assignee_id = v_assignee, updated_at = now(), updated_by = v_me
    where id = t.id returning * into t;
  end if;
  return private.task_json(t);
end $$;

create or replace function api.task_done(p_id bigint, p_done boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_member();
  t    crm.task;
begin
  update crm.task set done_at = case when p_done then coalesce(done_at, now()) else null end,
                      done_by = case when p_done then coalesce(done_by, v_me) else null end,
                      updated_at = now(), updated_by = v_me
  where id = p_id returning * into t;
  if not found then perform private.raise_err('CR404', 'not_found', 'task ' || p_id); end if;
  if p_done and t.entry_id is not null then
    perform private.write_activity(t.entry_id, 'task', v_me, 'Zadanie wykonane: ' || t.title, null, null, null, t.id);
  end if;
  return private.task_json(t);
end $$;

create or replace function api.task_delete(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  delete from crm.task where id = p_id;
  if not found then perform private.raise_err('CR404', 'not_found', 'task ' || p_id); end if;
  return jsonb_build_object('deleted', true);
end $$;

-- "Dziś" ---------------------------------------------------------------------------------------------------------------
-- My non-default leads that changed / disappeared / returned in the latest run, plus verified leads whose contact data
-- changed after verification (SPEC 5.3). One row per entry.
create or replace function private.today_changes(p_me smallint) returns table (entry_id int, change text, fields int)
language sql stable set search_path = '' as $$
  with latest as (select private.latest_run() as run, private.default_status() as dflt),
  ch as (
    select c.entry_id, case c.change when 2 then 'returned' else 'changed' end as change, c.fields
    from crm.reg_change c join crm.lead l on l.entry_id = c.entry_id, latest
    where c.run_id = latest.run and l.owner_id = p_me and l.status_id <> latest.dflt
    union all
    select e.id, 'gone', 0
    from crm.reg_entry e join crm.lead l on l.entry_id = e.id, latest
    where e.gone_run = latest.run and not e.in_register and l.owner_id = p_me and l.status_id <> latest.dflt
    union all
    select c.entry_id, 'changed', c.fields
    from crm.reg_change c join crm.import_run r on r.id = c.run_id join crm.lead l on l.entry_id = c.entry_id, latest
    where l.owner_id = p_me and l.validation = 2 and (c.fields & 1) <> 0 and r.finished_at > l.validated_at
      and c.run_id is distinct from latest.run)
  select distinct on (ch.entry_id) ch.entry_id, ch.change, ch.fields from ch order by ch.entry_id, ch.fields desc
$$;

create or replace function api.today() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me      smallint := private.require_member();
  v_today   date := private.today();
  v_steps   int[];
  v_n_steps int;
begin
  select coalesce(array_agg(s.id order by s.next_step_at, s.id), '{}') into v_steps from (
    select e.id, l.next_step_at from crm.lead l join crm.reg_entry e on e.id = l.entry_id
    where l.owner_id = v_me and l.next_step_at <= v_today and e.in_register
    order by l.next_step_at, e.id limit 100) s;
  select count(*) into v_n_steps from crm.lead l join crm.reg_entry e on e.id = l.entry_id
    where l.owner_id = v_me and l.next_step_at <= v_today and e.in_register;

  return jsonb_build_object(
    'tasksOverdue', (select coalesce(jsonb_agg(private.task_json(t) order by t.due_date, t.due_time nulls last, t.id), '[]')
                     from (select * from crm.task where assignee_id = v_me and done_at is null and due_date < v_today
                           order by due_date, due_time nulls last, id limit 200) t),
    'tasksToday', (select coalesce(jsonb_agg(private.task_json(t) order by t.due_time nulls last, t.id), '[]')
                   from crm.task t where t.assignee_id = v_me and t.done_at is null and t.due_date = v_today),
    'nextSteps', private.lead_rows(v_steps),
    'registerChanges', (select coalesce(jsonb_agg(jsonb_build_object('row', private.lead_row(e, l), 'change', x.change,
                          'fields', to_jsonb(private.change_groups(x.fields))) order by e.name), '[]')
                        from (select * from private.today_changes(v_me) order by entry_id limit 100) x
                        join crm.reg_entry e on e.id = x.entry_id left join crm.lead l on l.entry_id = e.id),
    'counts', jsonb_build_object(
      'tasksOverdue', (select count(*) from crm.task where assignee_id = v_me and done_at is null and due_date < v_today),
      'tasksToday', (select count(*) from crm.task where assignee_id = v_me and done_at is null and due_date = v_today),
      'nextSteps', v_n_steps,
      'registerChanges', (select count(*) from private.today_changes(v_me)),
      'openProposals', (select count(*) from crm.val_proposal where status = 0 and confidence >= private.min_conf())));
end $$;

-- Templates ------------------------------------------------------------------------------------------------------------
create or replace function private.template_json(t crm.template) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'kind', t.kind, 'name', t.name, 'subject', t.subject, 'body', t.body,
                            'active', t.active, 'sort', t.sort, 'updatedAt', t.updated_at)
$$;

create or replace function api.templates_list() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  return (select coalesce(jsonb_agg(private.template_json(t) order by t.kind, t.sort, lower(t.name)), '[]') from crm.template t);
end $$;

create or replace function api.template_upsert(p_template jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_member();
  t    crm.template;
  v_kind text := p_template ->> 'kind';
  v_name text;
  v_body text;
begin
  if jsonb_typeof(p_template) is distinct from 'object' or v_kind not in ('email', 'sms', 'call') then
    perform private.raise_err('CR422', 'invalid_payload', 'kind must be email|sms|call');
  end if;
  if p_template ->> 'id' is not null then
    select * into t from crm.template where id = (p_template ->> 'id')::int for update;
    if not found then perform private.raise_err('CR404', 'not_found', 'template ' || (p_template ->> 'id')); end if;
  end if;
  v_name := private.patch_text(p_template, 'name', 200);
  v_body := coalesce(p_template ->> 'body', t.body);
  if v_name is null or v_body is null or btrim(v_body) = '' then perform private.raise_err('CR422', 'invalid_payload', 'name and body are required'); end if;
  if length(v_body) > 10000 then perform private.raise_err('CR422', 'invalid_payload', 'body longer than 10000'); end if;
  begin
    if t.id is null then
      insert into crm.template (kind, name, subject, body, active, sort, updated_by)
      values (v_kind, v_name, private.patch_text(p_template, 'subject', 500), v_body,
              coalesce((p_template ->> 'active')::boolean, true), coalesce((p_template ->> 'sort')::smallint, 100), v_me)
      returning * into t;
    else
      update crm.template set kind = v_kind, name = v_name,
        subject = case when p_template ? 'subject' then private.patch_text(p_template, 'subject', 500) else subject end,
        body = v_body, active = coalesce((p_template ->> 'active')::boolean, active),
        sort = coalesce((p_template ->> 'sort')::smallint, sort), updated_at = now(), updated_by = v_me
      where id = t.id returning * into t;
    end if;
  exception when unique_violation then
    perform private.raise_err('CR409', 'duplicate_name', 'a template with this kind and name exists');
  end;
  return private.template_json(t);
end $$;

create or replace function api.template_delete(p_id int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  delete from crm.template where id = p_id;
  if not found then perform private.raise_err('CR404', 'not_found', 'template ' || p_id); end if;
  return jsonb_build_object('deleted', true);
end $$;

-- Lists ----------------------------------------------------------------------------------------------------------------
create or replace function api.lists_list() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  return (select coalesce(jsonb_agg(private.list_json(l) order by lower(l.name)), '[]') from crm.list l);
end $$;

create or replace function api.list_upsert(p_list jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_member();
  l    crm.list;
  v_name text := private.patch_text(p_list, 'name', 200);
begin
  if v_name is null then perform private.raise_err('CR422', 'invalid_payload', 'name is required'); end if;
  if p_list ->> 'id' is not null then
    select * into l from crm.list where id = (p_list ->> 'id')::int for update;
    if not found then perform private.raise_err('CR404', 'not_found', 'list ' || (p_list ->> 'id')); end if;
    if l.created_by is distinct from v_me and not private.is_owner(v_me) then
      perform private.raise_err('CR403', 'forbidden', 'only the creator or the owner edits a list');
    end if;
  end if;
  begin
    if l.id is null then
      insert into crm.list (name, note, created_by) values (v_name, private.patch_text(p_list, 'note', 1000), v_me) returning * into l;
    else
      update crm.list set name = v_name, note = case when p_list ? 'note' then private.patch_text(p_list, 'note', 1000) else note end,
        updated_at = now() where id = l.id returning * into l;
    end if;
  exception when unique_violation then
    perform private.raise_err('CR409', 'duplicate_name', 'a list with this name exists');
  end;
  return private.list_json(l);
end $$;

create or replace function api.list_delete(p_id int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_member();
  l    crm.list;
begin
  select * into l from crm.list where id = p_id;
  if not found then perform private.raise_err('CR404', 'not_found', 'list ' || p_id); end if;
  if l.created_by is distinct from v_me and not private.is_owner(v_me) then
    perform private.raise_err('CR403', 'forbidden', 'only the creator or the owner deletes a list');
  end if;
  delete from crm.list where id = p_id;
  return jsonb_build_object('deleted', true);
end $$;

-- Saved views ----------------------------------------------------------------------------------------------------------
create or replace function api.views_list() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  return (select coalesce(jsonb_agg(private.view_json(v) order by (v.scope <> 'system'), v.sort_order, v.name), '[]')
          from crm.saved_view v where v.scope in ('system', 'shared') or v.owner_id = v_me);
end $$;

create or replace function api.view_upsert(p_view jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me    smallint := private.require_member();
  v_owner boolean := private.is_owner(v_me);
  v       crm.saved_view;
  v_scope text;
  v_name  text;
begin
  if jsonb_typeof(p_view) is distinct from 'object' or jsonb_typeof(p_view -> 'filter') is distinct from 'object' then
    perform private.raise_err('CR422', 'invalid_payload', 'view needs a name and a filter object');
  end if;
  if p_view ->> 'id' is not null then
    select * into v from crm.saved_view where id = (p_view ->> 'id')::int for update;
    if not found then perform private.raise_err('CR404', 'not_found', 'view ' || (p_view ->> 'id')); end if;
    if (v.scope = 'system' and not v_owner) or (v.scope = 'private' and v.owner_id is distinct from v_me)
       or (v.scope = 'shared' and v.owner_id is distinct from v_me and not v_owner) then
      perform private.raise_err('CR403', 'forbidden', 'this view cannot be edited by the caller');
    end if;
  end if;
  v_scope := coalesce(p_view ->> 'scope', v.scope, 'private');
  if v_scope not in ('system', 'shared', 'private') then perform private.raise_err('CR422', 'invalid_payload', 'scope'); end if;
  if v_scope = 'system' and not v_owner then perform private.raise_err('CR403', 'owner_only', 'only the owner manages system views'); end if;
  v_name := coalesce(private.patch_text(p_view, 'name', 200), v.name);
  if v_name is null then perform private.raise_err('CR422', 'invalid_payload', 'name is required'); end if;
  -- validate the filter by compiling it once (CR422 on a bad filter)
  perform private.compile_filter(p_view -> 'filter', v_me);
  begin
    if v.id is null then
      insert into crm.saved_view (name, scope, owner_id, filter, sort, columns, note, sort_order)
      values (v_name, v_scope, case when v_scope = 'system' then null else v_me end, p_view -> 'filter',
              case when jsonb_typeof(p_view -> 'sort') = 'object' then p_view -> 'sort' end,
              case when jsonb_typeof(p_view -> 'columns') = 'array' then (select array_agg(x) from jsonb_array_elements_text(p_view -> 'columns') x) end,
              private.patch_text(p_view, 'note', 2000), coalesce((p_view ->> 'sortOrder')::smallint, 100))
      returning * into v;
    else
      update crm.saved_view set name = v_name, scope = v_scope,
        owner_id = case when v_scope = 'system' then null else coalesce(v.owner_id, v_me) end,
        filter = p_view -> 'filter',
        sort = case when p_view ? 'sort' then (case when jsonb_typeof(p_view -> 'sort') = 'object' then p_view -> 'sort' end) else sort end,
        columns = case when p_view ? 'columns' then (case when jsonb_typeof(p_view -> 'columns') = 'array'
                    then (select array_agg(x) from jsonb_array_elements_text(p_view -> 'columns') x) end) else columns end,
        note = case when p_view ? 'note' then private.patch_text(p_view, 'note', 2000) else note end,
        sort_order = coalesce((p_view ->> 'sortOrder')::smallint, sort_order), updated_at = now()
      where id = v.id returning * into v;
    end if;
  exception when unique_violation then
    perform private.raise_err('CR409', 'duplicate_name', 'a view with this name exists');
  end;
  return private.view_json(v);
end $$;

create or replace function api.view_delete(p_id int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_member();
  v    crm.saved_view;
begin
  select * into v from crm.saved_view where id = p_id;
  if not found then perform private.raise_err('CR404', 'not_found', 'view ' || p_id); end if;
  if (v.scope = 'system' and not private.is_owner(v_me)) or (v.scope = 'private' and v.owner_id is distinct from v_me)
     or (v.scope = 'shared' and v.owner_id is distinct from v_me and not private.is_owner(v_me)) then
    perform private.raise_err('CR403', 'forbidden', 'this view cannot be deleted by the caller');
  end if;
  delete from crm.saved_view where id = p_id;
  return jsonb_build_object('deleted', true);
end $$;

-- Tags, statuses -----------------------------------------------------------------------------------------------------
create or replace function api.tag_upsert(p_tag jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_member();
  t    crm.tag;
  v_name text := private.patch_text(p_tag, 'name', 100);
  v_color text := coalesce(p_tag ->> 'color', '#64748b');
begin
  if v_name is null then perform private.raise_err('CR422', 'invalid_payload', 'name is required'); end if;
  if v_color !~ '^#[0-9a-fA-F]{6}$' then perform private.raise_err('CR422', 'invalid_payload', 'color'); end if;
  begin
    if p_tag ->> 'id' is not null then
      update crm.tag set name = v_name, color = case when p_tag ? 'color' then v_color else color end, updated_at = now(), updated_by = v_me
      where id = (p_tag ->> 'id')::smallint returning * into t;
      if not found then perform private.raise_err('CR404', 'not_found', 'tag ' || (p_tag ->> 'id')); end if;
    else
      insert into crm.tag (name, color, updated_by) values (v_name, v_color, v_me) returning * into t;
    end if;
  exception when unique_violation then
    perform private.raise_err('CR409', 'duplicate_name', 'a tag with this name exists');
  end;
  return private.tag_json(t);
end $$;

create or replace function api.tag_delete(p_id smallint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_owner();
begin
  if not exists (select 1 from crm.tag where id = p_id) then perform private.raise_err('CR404', 'not_found', 'tag ' || p_id); end if;
  update crm.lead set tags = array_remove(tags, p_id), version = version + 1, updated_at = now(), updated_by = v_me where tags @> array[p_id];
  delete from crm.tag where id = p_id;
  return jsonb_build_object('deleted', true);
end $$;

create or replace function api.status_upsert(p_status jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_owner();
  s    crm.lead_status;
  v_name text := private.patch_text(p_status, 'name', 100);
  v_color text;
  v_stage text;
  v_default boolean;
begin
  if p_status ->> 'id' is not null then
    select * into s from crm.lead_status where id = (p_status ->> 'id')::smallint for update;
    if not found then perform private.raise_err('CR404', 'not_found', 'status ' || (p_status ->> 'id')); end if;
  end if;
  v_name := coalesce(v_name, s.name);
  if v_name is null then perform private.raise_err('CR422', 'invalid_payload', 'name is required'); end if;
  v_color := coalesce(p_status ->> 'color', s.color, '#64748b');
  v_stage := coalesce(p_status ->> 'stage', s.stage, 'open');
  v_default := coalesce((p_status ->> 'isDefault')::boolean, s.is_default, false);
  if v_color !~ '^#[0-9a-fA-F]{6}$' or v_stage not in ('open', 'won', 'lost', 'paused') then
    perform private.raise_err('CR422', 'invalid_payload', 'color or stage');
  end if;
  if s.id is not null and s.is_default and not v_default then
    perform private.raise_err('CR422', 'invalid_payload', 'isDefault: mark another status as default instead');
  end if;
  if v_default and coalesce((p_status ->> 'active')::boolean, s.active, true) is false then
    perform private.raise_err('CR422', 'invalid_payload', 'the default status must be active');
  end if;
  begin
    if v_default and (s.id is null or not s.is_default) then
      update crm.lead_status set is_default = false where is_default;
    end if;
    if s.id is null then
      insert into crm.lead_status (name, color, sort, stage, is_default, active, updated_by)
      values (v_name, v_color, coalesce((p_status ->> 'sort')::smallint, 100), v_stage, v_default,
              coalesce((p_status ->> 'active')::boolean, true), v_me) returning * into s;
    else
      update crm.lead_status set name = v_name, color = v_color, sort = coalesce((p_status ->> 'sort')::smallint, sort),
        stage = v_stage, is_default = v_default, active = coalesce((p_status ->> 'active')::boolean, active),
        updated_at = now(), updated_by = v_me where id = s.id returning * into s;
    end if;
  exception when unique_violation then
    perform private.raise_err('CR409', 'duplicate_name', 'a status with this name exists');
  end;
  return private.status_json(s);
end $$;

-- "Delete" keeps the row (inactive) so that history entries still resolve its name; leads move to p_reassign_to.
create or replace function api.status_delete(p_id smallint, p_reassign_to smallint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_owner();
  s    crm.lead_status;
  v_n  int;
begin
  select * into s from crm.lead_status where id = p_id for update;
  if not found then perform private.raise_err('CR404', 'not_found', 'status ' || p_id); end if;
  if s.is_default then perform private.raise_err('CR422', 'invalid_payload', 'the default status cannot be deleted'); end if;
  if p_reassign_to is null or p_reassign_to = p_id then perform private.raise_err('CR422', 'invalid_payload', 'reassignTo'); end if;
  perform private.check_status(p_reassign_to);
  with moved as (
    update crm.lead set status_id = p_reassign_to, version = version + 1, updated_at = now(), updated_by = v_me
    where status_id = p_id returning entry_id),
  act as (insert into crm.activity (entry_id, type, body, status_from, status_to, created_by)
          select entry_id, 'status', 'Status: ' || s.name || ' → ' || private.status_name(p_reassign_to) || ' (status usunięty)',
                 p_id, p_reassign_to, v_me from moved returning 1)
  select count(*) into v_n from act;
  update crm.lead_status set active = false, updated_at = now(), updated_by = v_me where id = p_id;
  return jsonb_build_object('reassigned', v_n);
end $$;

-- Members --------------------------------------------------------------------------------------------------------------
create or replace function private.team_member_json(m crm.team_member) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'email', m.email, 'displayName', m.display_name, 'role', m.role, 'phone', m.phone,
    'active', m.active, 'hasLoggedIn', m.user_id is not null, 'lastSeenAt', m.last_seen_at)
$$;

create or replace function api.members_list() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_owner();
begin
  return (select coalesce(jsonb_agg(private.team_member_json(m) order by m.display_name), '[]') from crm.team_member m);
end $$;

create or replace function api.member_upsert(p_member jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me    smallint := private.require_owner();
  m       crm.team_member;
  v_email text := lower(btrim(coalesce(p_member ->> 'email', '')));
  v_role  text := p_member ->> 'role';
  v_name  text := private.patch_text(p_member, 'displayName', 200);
  v_active boolean;
begin
  if jsonb_typeof(p_member) is distinct from 'object' or not private.email_valid(v_email) or v_role not in ('owner', 'member') or v_name is null then
    perform private.raise_err('CR422', 'invalid_payload', 'email, role (owner|member) and displayName are required');
  end if;
  if p_member ->> 'id' is not null then
    select * into m from crm.team_member where id = (p_member ->> 'id')::smallint for update;
    if not found then perform private.raise_err('CR404', 'not_found', 'member ' || (p_member ->> 'id')); end if;
  end if;
  v_active := coalesce((p_member ->> 'active')::boolean, m.active, true);
  -- the last active owner cannot be demoted or deactivated
  if m.id is not null and m.role = 'owner' and m.active and (v_role <> 'owner' or not v_active)
     and not exists (select 1 from crm.team_member x where x.id <> m.id and x.role = 'owner' and x.active) then
    perform private.raise_err('CR424', 'last_owner', 'at least one active owner must remain');
  end if;
  begin
    if m.id is null then
      insert into crm.team_member (email, display_name, role, phone, active) values
        (v_email, v_name, v_role, private.patch_text(p_member, 'phone', 50), v_active) returning * into m;
    else
      update crm.team_member set email = v_email, display_name = v_name, role = v_role, active = v_active,
        phone = case when p_member ? 'phone' then private.patch_text(p_member, 'phone', 50) else phone end,
        -- a changed e-mail must be linked to its auth user again on the next sign-in
        user_id = case when email <> v_email then null else user_id end, updated_at = now()
      where id = m.id returning * into m;
    end if;
  exception when unique_violation then
    perform private.raise_err('CR409', 'duplicate_email', 'this e-mail is already on the allowlist');
  end;
  return private.team_member_json(m);
end $$;

-- Settings -------------------------------------------------------------------------------------------------------------
create or replace function private.validation_params() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce((select value from crm.app_setting where key = 'val.params'), '{}'::jsonb)
$$;

create or replace function api.settings_get() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_owner();
begin
  return jsonb_build_object('settings', private.public_settings(), 'params', private.validation_params());
end $$;

create or replace function api.setting_set(p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_owner();
  k    text;
begin
  case p_key
    when 'ui.staleDays' then
      if jsonb_typeof(p_value) is distinct from 'number' or (p_value #>> '{}')::numeric not between 1 and 365 or (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric) then
        perform private.raise_err('CR422', 'invalid_payload', p_key || ' must be an integer 1..365'); end if;
    when 'val.minConfidence' then
      if jsonb_typeof(p_value) is distinct from 'number' or (p_value #>> '{}')::numeric not between 0 and 100 or (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric) then
        perform private.raise_err('CR422', 'invalid_payload', p_key || ' must be an integer 0..100'); end if;
    when 'history.keepRuns' then
      if jsonb_typeof(p_value) is distinct from 'number' or (p_value #>> '{}')::numeric not between 1 and 120 or (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric) then
        perform private.raise_err('CR422', 'invalid_payload', p_key || ' must be an integer 1..120'); end if;
    when 'sms.diacritics' then
      if jsonb_typeof(p_value) is distinct from 'string' or (p_value #>> '{}') not in ('keep', 'strip') then
        perform private.raise_err('CR422', 'invalid_payload', p_key || ' must be "keep" or "strip"'); end if;
    when 'val.params' then
      if jsonb_typeof(p_value) is distinct from 'object' then perform private.raise_err('CR422', 'invalid_payload', p_key || ' must be an object'); end if;
      foreach k in array array['genericDomainAccounts', 'emailClusterMax', 'domainClusterMax', 'wwwClusterMax', 'phoneClusterMax'] loop
        if jsonb_typeof(p_value -> k) is distinct from 'number' or (p_value ->> k)::numeric < 1 or (p_value ->> k)::numeric > 100000 then
          perform private.raise_err('CR422', 'invalid_payload', p_key || '.' || k || ' must be a number 1..100000'); end if;
      end loop;
      if jsonb_typeof(p_value -> 'staleBefore') is distinct from 'string' or (p_value ->> 'staleBefore') !~ '^\d{4}-\d{2}-\d{2}$' then
        perform private.raise_err('CR422', 'invalid_payload', p_key || '.staleBefore must be YYYY-MM-DD'); end if;
      perform (p_value ->> 'staleBefore')::date;
    when 'export.defaults' then
      if jsonb_typeof(p_value) is distinct from 'object' then perform private.raise_err('CR422', 'invalid_payload', p_key || ' must be an object'); end if;
    else
      perform private.raise_err('CR422', 'invalid_payload', 'unknown setting ' || left(coalesce(p_key, 'null'), 60));
  end case;
  insert into crm.app_setting (key, value, updated_by) values (p_key, p_value, v_me)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = v_me;
  return jsonb_build_object('ok', true);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
  perform private.raise_err('CR422', 'invalid_payload', p_key || ' has the wrong format');
  return null;
end $$;

create or replace function api.generic_domain_upsert(p_domain text, p_kind text, p_suggestion text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_owner();
  v_domain text := lower(btrim(coalesce(p_domain, '')));
begin
  if v_domain !~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,24}$' then
    perform private.raise_err('CR422', 'invalid_payload', 'domain');
  end if;
  if p_kind is null then
    delete from crm.generic_domain where domain = v_domain;
  else
    if p_kind not in ('free', 'generic', 'typo', 'social') then perform private.raise_err('CR422', 'invalid_payload', 'kind'); end if;
    insert into crm.generic_domain (domain, kind, suggestion, source) values (v_domain, p_kind, nullif(btrim(p_suggestion), ''), 'owner')
    on conflict (domain) do update set kind = excluded.kind, suggestion = excluded.suggestion, source = 'owner', updated_at = now();
  end if;
  return jsonb_build_object('ok', true);
end $$;

select private.apply_api_grants();
