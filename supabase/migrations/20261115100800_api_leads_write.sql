-- api: lead edits, bulk actions, activities, contacts (CONTRACT 4).

create or replace function private.valid_outcome(p_type text, p_outcome text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select p_outcome is null or p_outcome = any (case p_type
    when 'call' then array['rozmowa','nie_odbiera','zajete','poczta_glosowa','sekretariat','oddzwonic','zly_numer','nie_zainteresowany','nie_chce_kontaktu']
    when 'sms' then array['wyslano','odpowiedz']
    when 'email' then array['wyslano','odpowiedz','odbity']
    when 'meeting' then array['odbyte','odwolane','przelozone']
    else array[]::text[] end)
$$;

create or replace function private.validation_label(p_val smallint) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case p_val when 0 then 'Niezweryfikowany' when 1 then 'Do sprawdzenia' when 2 then 'Zweryfikowany'
                    when 3 then 'Odrzucony' else 'automatyczna' end
$$;

create or replace function private.member_name(p_id smallint) returns text
language sql stable set search_path = '' as $$ select coalesce((select display_name from crm.team_member where id = p_id), 'brak') $$;

create or replace function private.status_name(p_id smallint) returns text
language sql stable set search_path = '' as $$ select coalesce((select name from crm.lead_status where id = p_id), '?') $$;

-- Text from a jsonb patch field: null for JSON null/empty, trimmed, length-checked (CR422 names the field).
create or replace function private.patch_text(p_patch jsonb, p_key text, p_max int) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p_patch ->> p_key, '')), '');
begin
  if v is not null and length(v) > p_max then
    perform private.raise_err('CR422', 'invalid_payload', p_key || ' longer than ' || p_max);
  end if;
  return v;
end $$;

create or replace function private.check_status(p_id smallint) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_id is null or not exists (select 1 from crm.lead_status where id = p_id and active) then
    perform private.raise_err('CR422', 'invalid_payload', 'statusId: unknown or inactive status');
  end if;
end $$;

create or replace function private.check_member(p_id smallint, p_field text) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_id is null or not exists (select 1 from crm.team_member where id = p_id and active) then
    perform private.raise_err('CR422', 'invalid_payload', p_field || ': unknown or inactive member');
  end if;
end $$;

create or replace function private.clean_tags(p_json jsonb) returns smallint[]
language plpgsql stable set search_path = '' as $$
declare v smallint[];
begin
  if jsonb_typeof(p_json) is distinct from 'array' then perform private.raise_err('CR422', 'invalid_payload', 'tags must be an array'); end if;
  select coalesce(array_agg(distinct x::smallint order by x::smallint), '{}') into v from jsonb_array_elements_text(p_json) as t(x);
  if (select count(*) from crm.tag where id = any (v)) <> cardinality(v) then
    perform private.raise_err('CR422', 'invalid_payload', 'tags: unknown tag id');
  end if;
  return v;
end $$;

create or replace function api.lead_update(p_entry_id int, p_version int, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me      smallint := private.require_member();
  v_is_owner boolean := private.is_owner(v_me);
  l         crm.lead;
  v_created int;
  n_status  smallint;
  n_owner   smallint;
  n_tags    smallint[];
  n_short   text;
  n_step    date;
  n_stepn   text;
  n_val     smallint;
  n_valn    text;
  n_check   jsonb;
  n_dnc     boolean;
  n_dncr    text;
  v_val_changed boolean := false;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then perform private.raise_err('CR422', 'invalid_payload', 'patch must be an object'); end if;
  if not exists (select 1 from crm.reg_entry where id = p_entry_id) then
    perform private.raise_err('CR404', 'not_found', 'entry ' || p_entry_id);
  end if;
  insert into crm.lead (entry_id, status_id, updated_by) values (p_entry_id, private.default_status(), v_me)
  on conflict (entry_id) do nothing;
  get diagnostics v_created = row_count;
  select * into l from crm.lead where entry_id = p_entry_id for update;
  if (v_created = 1 and p_version <> 0) or (v_created = 0 and l.version <> p_version) then
    perform private.raise_err('CR409', 'version_conflict', 'lead version is ' || l.version);
  end if;

  n_status := l.status_id; n_owner := l.owner_id; n_tags := l.tags; n_short := l.short_name; n_step := l.next_step_at;
  n_stepn := l.next_step_note; n_val := l.validation; n_valn := l.validation_note; n_check := l.checklist;
  n_dnc := l.dnc; n_dncr := l.dnc_reason;

  if p_patch ? 'statusId' then
    n_status := (p_patch ->> 'statusId')::smallint;
    if n_status is distinct from l.status_id then perform private.check_status(n_status); end if;
  end if;
  if p_patch ? 'ownerId' then
    n_owner := (p_patch ->> 'ownerId')::smallint;
    if n_owner is not null and n_owner is distinct from l.owner_id then perform private.check_member(n_owner, 'ownerId'); end if;
  end if;
  if p_patch ? 'tags' then n_tags := private.clean_tags(p_patch -> 'tags'); end if;
  if p_patch ? 'shortName' then n_short := private.patch_text(p_patch, 'shortName', 200); end if;
  if p_patch ? 'nextStepAt' then n_step := (p_patch ->> 'nextStepAt')::date; end if;
  if p_patch ? 'nextStepNote' then n_stepn := private.patch_text(p_patch, 'nextStepNote', 500); end if;
  if p_patch ? 'validation' then
    n_val := (p_patch ->> 'validation')::smallint;
    if n_val is not null and n_val not between 0 and 3 then perform private.raise_err('CR422', 'invalid_payload', 'validation'); end if;
    v_val_changed := n_val is distinct from l.validation;
  end if;
  if p_patch ? 'validationNote' then n_valn := private.patch_text(p_patch, 'validationNote', 2000); end if;
  if p_patch ? 'checklist' then
    n_check := case when jsonb_typeof(p_patch -> 'checklist') = 'null' then null else p_patch -> 'checklist' end;
    if n_check is not null and (jsonb_typeof(n_check) is distinct from 'object' or length(n_check::text) > 8000) then
      perform private.raise_err('CR422', 'invalid_payload', 'checklist must be an object below 8000 characters');
    end if;
  end if;
  if p_patch ? 'dnc' then
    n_dnc := coalesce((p_patch ->> 'dnc')::boolean, false);
    if l.dnc and not n_dnc and not v_is_owner then
      perform private.raise_err('CR403', 'owner_only', 'only the owner clears the do-not-contact flag');
    end if;
  end if;
  if p_patch ? 'dncReason' then n_dncr := private.patch_text(p_patch, 'dncReason', 1000); end if;
  if not n_dnc then n_dncr := null; end if;

  update crm.lead set
    status_id = n_status, owner_id = n_owner, tags = n_tags, short_name = n_short, next_step_at = n_step,
    next_step_note = n_stepn, validation = n_val, validation_note = n_valn, checklist = n_check,
    validated_at = case when p_patch ? 'validation' then (case when n_val is null then null when v_val_changed then now() else validated_at end) else validated_at end,
    validated_by = case when p_patch ? 'validation' then (case when n_val is null then null when v_val_changed then v_me else validated_by end) else validated_by end,
    dnc = n_dnc, dnc_reason = n_dncr,
    dnc_at = case when n_dnc and not l.dnc then now() when not n_dnc then null else dnc_at end,
    dnc_by = case when n_dnc and not l.dnc then v_me when not n_dnc then null else dnc_by end,
    version = version + 1, updated_at = now(), updated_by = v_me
  where entry_id = p_entry_id;

  if n_status is distinct from l.status_id then
    perform private.write_activity(p_entry_id, 'status', v_me,
      'Status: ' || private.status_name(l.status_id) || ' → ' || private.status_name(n_status), null, l.status_id, n_status);
  end if;
  if n_owner is distinct from l.owner_id then
    perform private.write_activity(p_entry_id, 'owner', v_me,
      'Opiekun: ' || case when l.owner_id is null then 'brak' else private.member_name(l.owner_id) end
      || ' → ' || case when n_owner is null then 'brak' else private.member_name(n_owner) end);
  end if;
  if p_patch ? 'validation' and v_val_changed then
    perform private.write_activity(p_entry_id, 'validation', v_me,
      'Walidacja: ' || private.validation_label(l.validation) || ' → ' || private.validation_label(n_val)
      || coalesce(' (' || n_valn || ')', ''));
  elsif (p_patch ? 'checklist' and n_check is distinct from l.checklist) or (p_patch ? 'validationNote' and n_valn is distinct from l.validation_note) then
    perform private.write_activity(p_entry_id, 'validation', v_me, 'Zaktualizowano listę kontrolną walidacji' || coalesce(' (' || n_valn || ')', ''));
  end if;
  if n_dnc is distinct from l.dnc then
    perform private.write_activity(p_entry_id, 'dnc', v_me,
      case when n_dnc then 'Oznaczono: nie kontaktować' || coalesce(' — ' || n_dncr, '') else 'Zdjęto oznaczenie „nie kontaktować”' end);
  end if;
  return private.lead_row_by_id(p_entry_id);
end $$;

-- Bulk actions ---------------------------------------------------------------------------------------------------------
create or replace function api.leads_bulk(p_target jsonb, p_action jsonb) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '50s' as $$
declare
  v_me     smallint := private.require_member();
  v_ids    int[];
  v_act    text := p_action ->> 'action';
  v_n      int := 0;
  v_status smallint;
  v_owner  smallint;
  v_tag    smallint;
  v_list   int;
  v_val    smallint;
  v_dnc    boolean;
  v_reason text;
begin
  if v_act is null then perform private.raise_err('CR422', 'invalid_payload', 'action'); end if;
  if v_act = 'set_dnc' and not coalesce((p_action ->> 'dnc')::boolean, false) and not private.is_owner(v_me) then
    perform private.raise_err('CR403', 'owner_only', 'only the owner clears the do-not-contact flag');
  end if;
  v_ids := private.resolve_target(p_target, v_me, 20000);
  if cardinality(v_ids) = 0 then return jsonb_build_object('affected', 0); end if;

  if v_act in ('set_status', 'set_owner', 'add_tag', 'remove_tag', 'set_validation', 'set_dnc') then
    insert into crm.lead (entry_id, status_id, updated_by)
    select x, private.default_status(), v_me from unnest(v_ids) x on conflict (entry_id) do nothing;
  end if;

  if v_act = 'set_status' then
    v_status := (p_action ->> 'statusId')::smallint;
    perform private.check_status(v_status);
    with old as (select entry_id, status_id from crm.lead where entry_id = any (v_ids) and status_id is distinct from v_status for update),
    upd as (update crm.lead l set status_id = v_status, version = l.version + 1, updated_at = now(), updated_by = v_me
            from old where l.entry_id = old.entry_id returning l.entry_id, old.status_id as old_status),
    act as (insert into crm.activity (entry_id, type, body, status_from, status_to, created_by)
            select entry_id, 'status', 'Status: ' || private.status_name(old_status) || ' → ' || private.status_name(v_status),
                   old_status, v_status, v_me from upd returning 1)
    select count(*) into v_n from act;
  elsif v_act = 'set_owner' then
    v_owner := (p_action ->> 'ownerId')::smallint;
    if v_owner is not null then perform private.check_member(v_owner, 'ownerId'); end if;
    with old as (select entry_id, owner_id from crm.lead where entry_id = any (v_ids) and owner_id is distinct from v_owner for update),
    upd as (update crm.lead l set owner_id = v_owner, version = l.version + 1, updated_at = now(), updated_by = v_me
            from old where l.entry_id = old.entry_id returning l.entry_id, old.owner_id as old_owner),
    act as (insert into crm.activity (entry_id, type, body, created_by)
            select entry_id, 'owner', 'Opiekun: ' || case when old_owner is null then 'brak' else private.member_name(old_owner) end
                   || ' → ' || case when v_owner is null then 'brak' else private.member_name(v_owner) end, v_me from upd returning 1)
    select count(*) into v_n from act;
  elsif v_act = 'add_tag' or v_act = 'remove_tag' then
    v_tag := (p_action ->> 'tagId')::smallint;
    if not exists (select 1 from crm.tag where id = v_tag) then perform private.raise_err('CR422', 'invalid_payload', 'tagId'); end if;
    if v_act = 'add_tag' then
      with upd as (update crm.lead set tags = (select array_agg(distinct t order by t) from unnest(tags || v_tag) t),
                      version = version + 1, updated_at = now(), updated_by = v_me
                   where entry_id = any (v_ids) and not (tags @> array[v_tag]) returning 1)
      select count(*) into v_n from upd;
    else
      with upd as (update crm.lead set tags = array_remove(tags, v_tag), version = version + 1, updated_at = now(), updated_by = v_me
                   where entry_id = any (v_ids) and tags @> array[v_tag] returning 1)
      select count(*) into v_n from upd;
    end if;
  elsif v_act = 'add_to_list' then
    v_list := (p_action ->> 'listId')::int;
    if not exists (select 1 from crm.list where id = v_list) then perform private.raise_err('CR404', 'not_found', 'list ' || v_list); end if;
    with ins as (insert into crm.list_member (list_id, entry_id, added_by) select v_list, x, v_me from unnest(v_ids) x
                 on conflict do nothing returning 1)
    select count(*) into v_n from ins;
  elsif v_act = 'remove_from_list' then
    v_list := (p_action ->> 'listId')::int;
    with del as (delete from crm.list_member where list_id = v_list and entry_id = any (v_ids) returning 1)
    select count(*) into v_n from del;
  elsif v_act = 'set_validation' then
    v_val := (p_action ->> 'validation')::smallint;
    if v_val is not null and v_val not between 0 and 3 then perform private.raise_err('CR422', 'invalid_payload', 'validation'); end if;
    with old as (select entry_id, validation from crm.lead where entry_id = any (v_ids) and validation is distinct from v_val for update),
    upd as (update crm.lead l set validation = v_val, validated_at = case when v_val is null then null else now() end,
                   validated_by = case when v_val is null then null else v_me end,
                   version = l.version + 1, updated_at = now(), updated_by = v_me
            from old where l.entry_id = old.entry_id returning l.entry_id, old.validation as old_val),
    act as (insert into crm.activity (entry_id, type, body, created_by)
            select entry_id, 'validation', 'Walidacja: ' || private.validation_label(old_val) || ' → ' || private.validation_label(v_val), v_me
            from upd returning 1)
    select count(*) into v_n from act;
  elsif v_act = 'set_dnc' then
    v_dnc := coalesce((p_action ->> 'dnc')::boolean, false);
    v_reason := private.patch_text(p_action, 'reason', 1000);
    with old as (select entry_id from crm.lead where entry_id = any (v_ids) and dnc is distinct from v_dnc for update),
    upd as (update crm.lead l set dnc = v_dnc, dnc_reason = case when v_dnc then v_reason else null end,
                   dnc_at = case when v_dnc then now() else null end, dnc_by = case when v_dnc then v_me else null end,
                   version = l.version + 1, updated_at = now(), updated_by = v_me
            from old where l.entry_id = old.entry_id returning l.entry_id),
    act as (insert into crm.activity (entry_id, type, body, created_by)
            select entry_id, 'dnc', case when v_dnc then 'Oznaczono: nie kontaktować' || coalesce(' — ' || v_reason, '')
                                         else 'Zdjęto oznaczenie „nie kontaktować”' end, v_me from upd returning 1)
    select count(*) into v_n from act;
  else
    perform private.raise_err('CR422', 'invalid_payload', 'unknown action ' || left(v_act, 40));
  end if;
  return jsonb_build_object('affected', v_n);
end $$;

-- Activities ------------------------------------------------------------------------------------------------------------
create or replace function api.activity_add(p_entry_id int, p_activity jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me      smallint := private.require_member();
  v_type    text := p_activity ->> 'type';
  v_outcome text := nullif(btrim(coalesce(p_activity ->> 'outcome', '')), '');
  v_body    text := nullif(btrim(coalesce(p_activity ->> 'body', '')), '');
  v_at      timestamptz;
  v_id      bigint;
  l         crm.lead;
  n_status  smallint;
  n_step    date;
  n_stepn   text;
  n_dnc     boolean;
  n_dncr    text;
  v_task    jsonb := p_activity -> 'task';
  v_task_id bigint;
begin
  if jsonb_typeof(p_activity) is distinct from 'object' or v_type is null or v_type not in ('call', 'sms', 'email', 'meeting', 'note') then
    perform private.raise_err('CR422', 'invalid_payload', 'type must be call|sms|email|meeting|note');
  end if;
  if not private.valid_outcome(v_type, v_outcome) then perform private.raise_err('CR422', 'invalid_payload', 'outcome'); end if;
  if v_body is not null and length(v_body) > 5000 then perform private.raise_err('CR422', 'invalid_payload', 'body longer than 5000'); end if;
  perform private.ensure_lead(p_entry_id, v_me);
  select * into l from crm.lead where entry_id = p_entry_id for update;
  v_at := coalesce((p_activity ->> 'occurredAt')::timestamptz, now());

  insert into crm.activity (entry_id, type, outcome, contact_value, subject, body, template_id, occurred_at, created_by)
  values (p_entry_id, v_type, v_outcome, private.patch_text(p_activity, 'contactValue', 500), private.patch_text(p_activity, 'subject', 500),
          v_body, (p_activity ->> 'templateId')::int, v_at, v_me)
  returning id into v_id;

  n_status := l.status_id; n_step := l.next_step_at; n_stepn := l.next_step_note; n_dnc := l.dnc; n_dncr := l.dnc_reason;
  if p_activity ? 'statusId' and p_activity ->> 'statusId' is not null then
    n_status := (p_activity ->> 'statusId')::smallint;
    if n_status is distinct from l.status_id then perform private.check_status(n_status); end if;
  end if;
  if p_activity ? 'nextStepAt' then n_step := (p_activity ->> 'nextStepAt')::date; end if;
  if p_activity ? 'nextStepNote' then n_stepn := private.patch_text(p_activity, 'nextStepNote', 500); end if;
  if coalesce((p_activity ->> 'dnc')::boolean, false) and not l.dnc then
    n_dnc := true; n_dncr := private.patch_text(p_activity, 'dncReason', 1000);
  end if;

  update crm.lead set
    status_id = n_status, next_step_at = n_step, next_step_note = n_stepn,
    dnc = n_dnc, dnc_reason = n_dncr,
    dnc_at = case when n_dnc and not l.dnc then now() else dnc_at end,
    dnc_by = case when n_dnc and not l.dnc then v_me else dnc_by end,
    last_contact_at = case when v_type in ('call', 'sms', 'email', 'meeting') then greatest(coalesce(last_contact_at, v_at), v_at) else last_contact_at end,
    version = version + 1, updated_at = now(), updated_by = v_me
  where entry_id = p_entry_id;

  if n_status is distinct from l.status_id then
    perform private.write_activity(p_entry_id, 'status', v_me,
      'Status: ' || private.status_name(l.status_id) || ' → ' || private.status_name(n_status), null, l.status_id, n_status);
  end if;
  if n_dnc and not l.dnc then
    perform private.write_activity(p_entry_id, 'dnc', v_me, 'Oznaczono: nie kontaktować' || coalesce(' — ' || n_dncr, ''));
  end if;
  if jsonb_typeof(v_task) = 'object' then
    insert into crm.task (entry_id, title, note, due_date, assignee_id, created_by, updated_by)
    values (p_entry_id, coalesce(private.patch_text(v_task, 'title', 300), private.raise_err_text('task.title')),
            private.patch_text(v_task, 'note', 2000), (v_task ->> 'dueDate')::date,
            coalesce((v_task ->> 'assigneeId')::smallint, v_me), v_me, v_me)
    returning id into v_task_id;
  end if;
  return jsonb_build_object('activityId', v_id, 'row', private.lead_row_by_id(p_entry_id));
end $$;

create or replace function private.raise_err_text(p_field text) returns text
language plpgsql set search_path = '' as $$
begin
  perform private.raise_err('CR422', 'invalid_payload', p_field || ' is required');
  return null;
end $$;

create or replace function private.activity_item(a crm.activity, p_me smallint) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', 'a:' || a.id, 'at', a.occurred_at, 'entryId', a.entry_id, 'source', 'activity',
    'type', a.type, 'outcome', a.outcome, 'contactValue', a.contact_value, 'subject', a.subject, 'body', a.body,
    'statusFrom', a.status_from, 'statusTo', a.status_to, 'fields', null, 'old', null, 'byId', a.created_by,
    'editable', a.type in ('call', 'sms', 'email', 'meeting', 'note')
                and (private.is_owner(p_me) or (a.created_by = p_me and a.created_at > now() - interval '24 hours')))
$$;

create or replace function api.activity_update(p_id bigint, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_member();
  a    crm.activity;
  v_outcome text;
begin
  select * into a from crm.activity where id = p_id for update;
  if not found then perform private.raise_err('CR404', 'not_found', 'activity ' || p_id); end if;
  if a.type not in ('call', 'sms', 'email', 'meeting', 'note')
     or not (private.is_owner(v_me) or (a.created_by = v_me and a.created_at > now() - interval '24 hours')) then
    perform private.raise_err('CR403', 'not_editable', 'only own user activities younger than 24 hours, or any as owner');
  end if;
  v_outcome := case when p_patch ? 'outcome' then nullif(btrim(coalesce(p_patch ->> 'outcome', '')), '') else a.outcome end;
  if not private.valid_outcome(a.type, v_outcome) then perform private.raise_err('CR422', 'invalid_payload', 'outcome'); end if;
  update crm.activity set
    outcome = v_outcome,
    subject = case when p_patch ? 'subject' then private.patch_text(p_patch, 'subject', 500) else subject end,
    body = case when p_patch ? 'body' then private.patch_text(p_patch, 'body', 5000) else body end,
    occurred_at = case when p_patch ? 'occurredAt' and p_patch ->> 'occurredAt' is not null then (p_patch ->> 'occurredAt')::timestamptz else occurred_at end,
    updated_at = now()
  where id = p_id returning * into a;
  update crm.lead set last_contact_at = (select max(x.occurred_at) from crm.activity x
                                         where x.entry_id = a.entry_id and x.type in ('call', 'sms', 'email', 'meeting'))
  where entry_id = a.entry_id;
  return private.activity_item(a, v_me);
end $$;

create or replace function api.activity_delete(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_member();
  a    crm.activity;
begin
  select * into a from crm.activity where id = p_id for update;
  if not found then perform private.raise_err('CR404', 'not_found', 'activity ' || p_id); end if;
  if a.type not in ('call', 'sms', 'email', 'meeting', 'note')
     or not (private.is_owner(v_me) or (a.created_by = v_me and a.created_at > now() - interval '24 hours')) then
    perform private.raise_err('CR403', 'not_editable', 'only own user activities younger than 24 hours, or any as owner');
  end if;
  delete from crm.activity where id = p_id;
  update crm.lead set last_contact_at = (select max(x.occurred_at) from crm.activity x
                                         where x.entry_id = a.entry_id and x.type in ('call', 'sms', 'email', 'meeting'))
  where entry_id = a.entry_id;
  return jsonb_build_object('deleted', true);
end $$;

-- Contacts -------------------------------------------------------------------------------------------------------------
create or replace function private.phone_norm(p_value text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case
    when length(d) = 9 then d
    when length(d) = 10 and left(d, 1) = '0' then right(d, 9)
    when length(d) = 11 and left(d, 2) = '48' then right(d, 9)
    when length(d) = 13 and left(d, 4) = '0048' then right(d, 9)
    else nullif(d, '') end
  from (select regexp_replace(coalesce(p_value, ''), '\D', '', 'g') as d) s
$$;

create or replace function private.contact_json(c crm.lead_contact) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'kind', c.kind, 'value', c.value, 'personName', c.person_name,
    'personRole', c.person_role, 'status', c.status, 'isPrimary', c.is_primary, 'source', c.source,
    'note', c.note, 'updatedAt', c.updated_at)
$$;

create or replace function api.contact_upsert(p_entry_id int, p_contact jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me     smallint := private.require_member();
  c        crm.lead_contact;
  v_kind   text := p_contact ->> 'kind';
  v_value  text;
  v_norm   text;
  v_status text;
  v_prim   boolean;
  v_source text;
begin
  if not exists (select 1 from crm.reg_entry where id = p_entry_id) then perform private.raise_err('CR404', 'not_found', 'entry ' || p_entry_id); end if;
  if jsonb_typeof(p_contact) is distinct from 'object' or v_kind not in ('email', 'phone', 'www', 'person') then
    perform private.raise_err('CR422', 'invalid_payload', 'contact.kind');
  end if;
  if p_contact ? 'id' and p_contact ->> 'id' is not null then
    select * into c from crm.lead_contact where id = (p_contact ->> 'id')::int and entry_id = p_entry_id for update;
    if not found then perform private.raise_err('CR404', 'not_found', 'contact ' || (p_contact ->> 'id')); end if;
    if c.kind <> v_kind then perform private.raise_err('CR422', 'invalid_payload', 'contact.kind cannot change'); end if;
  end if;
  v_value := case when p_contact ? 'value' then private.patch_text(p_contact, 'value', 500) else c.value end;
  v_status := coalesce(p_contact ->> 'status', c.status, 'unknown');
  v_source := coalesce(p_contact ->> 'source', c.source, 'crm');
  v_prim := coalesce((p_contact ->> 'isPrimary')::boolean, c.is_primary, false);
  if v_status not in ('ok', 'invalid', 'unknown') or v_source not in ('crm', 'register') then
    perform private.raise_err('CR422', 'invalid_payload', 'contact.status or contact.source');
  end if;
  if v_kind <> 'person' and v_value is null then perform private.raise_err('CR422', 'invalid_payload', 'contact.value is required'); end if;
  if v_kind = 'person' and coalesce(private.patch_text(p_contact, 'personName', 200), c.person_name) is null then
    perform private.raise_err('CR422', 'invalid_payload', 'contact.personName is required');
  end if;
  v_norm := case v_kind when 'email' then private.normalize_email(v_value) when 'phone' then private.phone_norm(v_value)
                        when 'www' then coalesce(private.normalize_www(v_value), lower(v_value)) else null end;
  if v_kind = 'email' and v_source = 'crm' and (v_norm is null or not private.email_valid(v_norm)) then
    perform private.raise_err('CR422', 'invalid_payload', 'contact.value is not a valid e-mail address');
  end if;
  if v_kind = 'phone' and v_source = 'crm' and (v_norm is null or length(v_norm) < 6) then
    perform private.raise_err('CR422', 'invalid_payload', 'contact.value is not a valid phone number');
  end if;
  if v_prim then
    update crm.lead_contact set is_primary = false where entry_id = p_entry_id and kind = v_kind and is_primary and id is distinct from c.id;
  end if;
  if c.id is null then
    insert into crm.lead_contact (entry_id, kind, value, value_norm, person_name, person_role, status, is_primary, source, note, updated_by)
    values (p_entry_id, v_kind, v_value, v_norm, private.patch_text(p_contact, 'personName', 200), private.patch_text(p_contact, 'personRole', 200),
            v_status, v_prim, v_source, private.patch_text(p_contact, 'note', 1000), v_me)
    returning * into c;
  else
    update crm.lead_contact set
      value = v_value, value_norm = v_norm,
      person_name = case when p_contact ? 'personName' then private.patch_text(p_contact, 'personName', 200) else person_name end,
      person_role = case when p_contact ? 'personRole' then private.patch_text(p_contact, 'personRole', 200) else person_role end,
      status = v_status, is_primary = v_prim,
      note = case when p_contact ? 'note' then private.patch_text(p_contact, 'note', 1000) else note end,
      updated_at = now(), updated_by = v_me
    where id = c.id returning * into c;
  end if;
  return private.contact_json(c);
end $$;

create or replace function api.contact_delete(p_id int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  delete from crm.lead_contact where id = p_id;
  if not found then perform private.raise_err('CR404', 'not_found', 'contact ' || p_id); end if;
  return jsonb_build_object('deleted', true);
end $$;

select private.apply_api_grants();
