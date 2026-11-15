-- CRM writes: lead edits and version conflicts, do-not-contact rule, activities, bulk actions, tasks, templates, lists,
-- views, tags, statuses, members, settings, contacts, timeline.
begin;
select no_plan();

-- The synthetic members sign in with made-up auth ids and are linked on first sign-in. A database that e2e runs already used
-- has them linked to real auth users, so unlink them here (rolled back with the test transaction).
update crm.team_member set user_id = null where email like '%@example.test';

create function public.t_login(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', md5(p_email)::uuid, 'email', p_email, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function public.t_logout() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create function public.t_int(p_sql text) returns int language plpgsql security definer set search_path = '' as $$
declare v int; begin execute p_sql into v; return v; end $$;
create function public.t_entry(p_ks text) returns int language sql security definer set search_path = '' as $$ select id from crm.reg_entry where ks = p_ks $$;

select public.t_login('anna@example.test');

-- lead_update / versions -----------------------------------------------------------------------------------------------------
select is(api.lead_update(public.t_entry('P-00010'), 0, '{"statusId":2}') ->> 'version', '2', 'first write creates the lead row (version 0 expected) and bumps the version');
select is(api.lead_update(public.t_entry('P-00010'), 2, '{"nextStepAt":"2030-01-02","nextStepNote":"Zadzwonić"}') ->> 'nextStepAt', '2030-01-02', 'update with the current version');
select throws_ok(format($$select api.lead_update(%s, 2, '{"statusId":3}')$$, public.t_entry('P-00010')), 'CR409', null, 'stale version: CR409');
select throws_ok(format($$select api.lead_update(%s, 0, '{"statusId":3}')$$, public.t_entry('P-00010')), 'CR409', null, 'version 0 when the row exists: CR409');
select throws_ok(format($$select api.lead_update(%s, 3, '{"statusId":99}')$$, public.t_entry('P-00010')), 'CR422', null, 'unknown status: CR422');
select throws_ok($$select api.lead_update(999999, 0, '{}')$$, 'CR404', null, 'unknown entry: CR404');
select throws_ok(format($$select api.lead_update(%s, 3, '{"tags":[999]}')$$, public.t_entry('P-00010')), 'CR422', null, 'unknown tag: CR422');
select is(api.lead_update(public.t_entry('P-00010'), 3, '{"tags":[1,2,1],"shortName":"  Poz Dziesiąta  ","ownerId":3}') -> 'tags', '[1,2]'::jsonb, 'tags are de-duplicated and sorted');
select is(api.lead_get(public.t_entry('P-00010')) -> 'lead' ->> 'shortName', 'Poz Dziesiąta', 'short name is trimmed');
select public.t_logout();
select is(public.t_int($$select count(*)::int from crm.activity where entry_id = (select id from crm.reg_entry where ks = 'P-00010') and type = 'status'$$), 1, 'status change wrote one status activity');
select is(public.t_int($$select count(*)::int from crm.activity where entry_id = (select id from crm.reg_entry where ks = 'P-00010') and type = 'owner'$$), 1, 'owner change wrote one owner activity');
select public.t_login('anna@example.test');

-- do-not-contact ---------------------------------------------------------------------------------------------------------------
select is(api.lead_update(public.t_entry('P-00010'), 4, '{"dnc":true,"dncReason":"Prosił o brak kontaktu"}') ->> 'dnc', 'true', 'member sets do-not-contact');
select throws_ok(format($$select api.lead_update(%s, 5, '{"dnc":false}')$$, public.t_entry('P-00010')), 'CR403', null, 'member cannot clear do-not-contact');
select public.t_login('owner@example.test');
select is(api.lead_update(public.t_entry('P-00010'), 5, '{"dnc":false}') ->> 'dnc', 'false', 'owner clears do-not-contact');
select is(api.lead_get(public.t_entry('P-00010')) -> 'lead' ->> 'dncReason', null, 'clearing removes the reason');

-- validation status and checklist -------------------------------------------------------------------------------------------------
select public.t_login('anna@example.test');
select is(api.lead_update(public.t_entry('P-00010'), 6, '{"validation":2,"checklist":{"podmiotDziala":true,"telefonOk":true,"decydent":"Jan Testowy"}}') ->> 'validation', '2', 'human validation status');
select is((api.lead_get(public.t_entry('P-00010')) -> 'row' ->> 'validationIsDerived')::boolean, false, 'human status is not derived');
select is(api.lead_get(public.t_entry('P-00010')) -> 'lead' -> 'checklist' ->> 'decydent', 'Jan Testowy', 'checklist stored');
select is((api.lead_update(public.t_entry('P-00010'), 7, '{"validation":null}') ->> 'validationIsDerived')::boolean, true, 'validation null returns to derived');
select throws_ok(format($$select api.lead_update(%s, 8, '{"validation":7}')$$, public.t_entry('P-00010')), 'CR422', null, 'validation outside 0..3: CR422');

-- activities ------------------------------------------------------------------------------------------------------------------------
select is((api.activity_add(public.t_entry('P-00011'), '{"type":"call","outcome":"rozmowa","body":"Rozmowa o ofercie","statusId":4,"nextStepAt":"2031-03-01","nextStepNote":"Spotkanie","task":{"title":"Przygotować ofertę","dueDate":"2031-02-20"}}') -> 'row' ->> 'statusId')::int, 4, 'activity_add applies the status side effect');
select is(api.lead_get(public.t_entry('P-00011')) -> 'row' ->> 'nextStepAt', '2031-03-01', 'activity_add applies the next step');
select ok(api.lead_get(public.t_entry('P-00011')) -> 'row' ->> 'lastContactAt' is not null, 'a call sets last contact');
select is((api.tasks_list('mine', true, null, public.t_entry('P-00011'), 0, 10) -> 0 ->> 'title'), 'Przygotować ofertę', 'activity_add creates the task');
select throws_ok(format($$select api.activity_add(%s, '{"type":"call","outcome":"nie_ma"}')$$, public.t_entry('P-00011')), 'CR422', null, 'unknown outcome: CR422');
select throws_ok(format($$select api.activity_add(%s, '{"type":"status"}')$$, public.t_entry('P-00011')), 'CR422', null, 'system activity types cannot be created by users: CR422');
select throws_ok(format($$select api.activity_add(%s, jsonb_build_object('type','note','body', repeat('x', 5001)))$$, public.t_entry('P-00011')), 'CR422', null, 'note longer than 5000: CR422');
select is((api.activity_add(public.t_entry('P-00011'), '{"type":"note","body":"Notatka"}') ->> 'activityId')::int > 0, true, 'note is created');
select is(api.lead_get(public.t_entry('P-00011')) -> 'row' ->> 'statusId', '4', 'a note leaves the status unchanged');
select is((api.lead_timeline(public.t_entry('P-00011'), 'entry', null, 20) -> 0 ->> 'type'), 'note', 'timeline is newest first');
select is(jsonb_array_length(api.lead_timeline(public.t_entry('P-00011'), 'entry', null, 20)) >= 4, true, 'timeline has call, status change, note and register first import');
select ok(exists (select 1 from jsonb_array_elements(api.lead_timeline(public.t_entry('P-00011'), 'entry', null, 20)) i where i ->> 'type' = 'register_new'), 'timeline has the synthetic first-import item');
select is((select (i ->> 'editable')::boolean from jsonb_array_elements(api.lead_timeline(public.t_entry('P-00011'), 'entry', null, 20)) i where i ->> 'type' = 'note'), true, 'own fresh note is editable');
select is((select (i ->> 'editable')::boolean from jsonb_array_elements(api.lead_timeline(public.t_entry('P-00011'), 'entry', null, 20)) i where i ->> 'type' = 'status'), false, 'system items are not editable');
select throws_ok($$select api.lead_timeline(1, 'entry', null, 101)$$, 'CR413', null, 'timeline limit above 100: CR413');
select public.t_login('piotr@example.test');
select throws_ok(format($$select api.activity_delete(%s)$$, public.t_int($$select max(id)::int from crm.activity where type = 'note' and created_by = (select id from crm.team_member where email = 'anna@example.test')$$)),
  'CR403', null, 'another member cannot delete a colleague''s activity');
select public.t_login('anna@example.test');
select is(api.activity_delete(public.t_int($$select max(id)::int from crm.activity where type = 'note' and created_by = (select id from crm.team_member where email = 'anna@example.test')$$)) ->> 'deleted', 'true', 'author deletes own fresh note');
select is(api.activity_update(public.t_int($$select max(id)::int from crm.activity where type = 'call' and created_by = (select id from crm.team_member where email = 'anna@example.test')$$), '{"body":"Poprawione","outcome":"zajete"}') ->> 'body', 'Poprawione', 'author edits own fresh call');

-- tasks / today -----------------------------------------------------------------------------------------------------------------------
select public.t_login('piotr@example.test');
select is((api.task_upsert(format('{"title":"Zadzwonić jutro","dueDate":"2020-01-01","entryId":%s}', public.t_entry('P-00012'))::jsonb) ->> 'assigneeId')::int, public.t_int($$select id::int from crm.team_member where email = 'piotr@example.test'$$), 'task assignee defaults to the caller');
select is((api.today() -> 'counts' ->> 'tasksOverdue')::int, 1, 'overdue task counted in Dziś');
select is((api.today() -> 'counts' ->> 'tasksToday')::int, 1, 'seed task due today counted in Dziś');
select throws_ok($$select api.task_upsert('{"dueDate":"2030-01-01"}')$$, 'CR422', null, 'task without a title: CR422');
select throws_ok($$select api.task_upsert('{"title":"x"}')$$, 'CR422', null, 'task without a due date: CR422');
select is(api.task_done((api.tasks_list('mine', true, '2021-01-01', null, 0, 10) -> 0 ->> 'id')::bigint, true) ->> 'doneAt' is not null, true, 'task done');
select is((api.today() -> 'counts' ->> 'tasksOverdue')::int, 0, 'done task leaves Dziś');
select is(jsonb_array_length(api.tasks_list('mine', false, null, null, 0, 10)), 1, 'done list');
select is(jsonb_array_length(api.lead_timeline(public.t_entry('P-00012'), 'entry', null, 20)) >= 2, true, 'done task appears in the lead timeline');
select throws_ok($$select api.tasks_list('mine', true, null, null, 0, 201)$$, 'CR413', null, 'tasks limit above 200: CR413');

-- bulk ----------------------------------------------------------------------------------------------------------------------------
select public.t_login('anna@example.test');
select is((api.leads_bulk('{"entryIds":[]}', '{"action":"set_status","statusId":2}') ->> 'affected')::int, 0, 'empty selection');
select is((api.leads_bulk(format('{"entryIds":[%s,%s]}', public.t_entry('P-00020'), public.t_entry('P-00021'))::jsonb, '{"action":"set_status","statusId":3}') ->> 'affected')::int, 2, 'bulk set_status on two entries');
select is((api.leads_bulk(format('{"entryIds":[%s,%s]}', public.t_entry('P-00020'), public.t_entry('P-00021'))::jsonb, '{"action":"set_status","statusId":3}') ->> 'affected')::int, 0, 'repeating changes nothing');
select is((api.leads_bulk(format('{"entryIds":[%s,%s]}', public.t_entry('P-00020'), public.t_entry('P-00021'))::jsonb, '{"action":"add_tag","tagId":1}') ->> 'affected')::int, 2, 'bulk add_tag');
select is((api.leads_bulk(format('{"entryIds":[%s]}', public.t_entry('P-00020'))::jsonb, '{"action":"remove_tag","tagId":1}') ->> 'affected')::int, 1, 'bulk remove_tag');
select is((api.leads_bulk(format('{"entryIds":[%s,%s]}', public.t_entry('P-00020'), public.t_entry('P-00021'))::jsonb, '{"action":"add_to_list","listId":1}') ->> 'affected')::int, 2, 'bulk add_to_list');
select is((api.leads_bulk(format('{"entryIds":[%s]}', public.t_entry('P-00020'))::jsonb, '{"action":"remove_from_list","listId":1}') ->> 'affected')::int, 1, 'bulk remove_from_list');
select is((api.leads_bulk(format('{"entryIds":[%s]}', public.t_entry('P-00020'))::jsonb, '{"action":"set_owner","ownerId":2}') ->> 'affected')::int, 1, 'bulk set_owner');
select is((api.leads_bulk(format('{"entryIds":[%s]}', public.t_entry('P-00020'))::jsonb, '{"action":"set_validation","validation":3}') ->> 'affected')::int, 1, 'bulk set_validation');
select is((api.leads_bulk(format('{"entryIds":[%s]}', public.t_entry('P-00020'))::jsonb, '{"action":"set_dnc","dnc":true,"reason":"test"}') ->> 'affected')::int, 1, 'member bulk sets do-not-contact');
select throws_ok(format($$select api.leads_bulk('{"entryIds":[%s]}', '{"action":"set_dnc","dnc":false}')$$, public.t_entry('P-00020')), 'CR403', null, 'member bulk cannot clear do-not-contact');
select throws_ok($$select api.leads_bulk('{"entryIds":[1]}', '{"action":"explode"}')$$, 'CR422', null, 'unknown bulk action: CR422');
select throws_ok(format($$select api.leads_bulk('{"entryIds":%s}', '{"action":"set_status","statusId":2}')$$, (select jsonb_agg(g) from generate_series(1, 5001) g)::text), 'CR413', null, 'entryIds above 5000: CR413');
select is(public.t_int($$select count(*)::int from crm.activity where type = 'status' and entry_id = (select id from crm.reg_entry where ks = 'P-00021')$$), 1, 'bulk wrote one status activity per changed lead');

-- templates, lists, views, tags -----------------------------------------------------------------------------------------------------
select is(api.template_upsert('{"kind":"sms","name":"Krótki","body":"Dzień dobry {{nazwa}}"}') ->> 'kind', 'sms', 'template created');
select throws_ok($$select api.template_upsert('{"kind":"sms","name":"Krótki","body":"x"}')$$, 'CR409', null, 'duplicate template name: CR409');
select throws_ok($$select api.template_upsert('{"kind":"fax","name":"x","body":"x"}')$$, 'CR422', null, 'bad template kind: CR422');
select is(api.list_upsert('{"name":"Moja lista"}') ->> 'members', '0', 'list created empty');
select throws_ok($$select api.list_upsert('{"name":"moja LISTA"}')$$, 'CR409', null, 'list names are unique case-insensitively');
select is(api.view_upsert('{"name":"Mój widok","filter":{"kind":"p"}}') ->> 'scope', 'private', 'a view defaults to private');
select throws_ok($$select api.view_upsert('{"name":"Systemowy","scope":"system","filter":{}}')$$, 'CR403', null, 'member cannot create a system view');
select throws_ok($$select api.view_upsert('{"name":"Zły","filter":{"kind":"x"}}')$$, 'CR422', null, 'a view with an invalid filter is refused');
select is(api.view_upsert('{"name":"Wspólny","scope":"shared","filter":{"owner":["me"]}}') ->> 'scope', 'shared', 'shared view');
select public.t_login('piotr@example.test');
select is((select count(*)::int from jsonb_array_elements(api.views_list()) v where v ->> 'name' = 'Mój widok'), 0, 'private views of others are invisible');
select is((select count(*)::int from jsonb_array_elements(api.views_list()) v where v ->> 'name' = 'Wspólny'), 1, 'shared views are visible');
select throws_ok(format($$select api.view_delete(%s)$$, (select (v ->> 'id') from jsonb_array_elements(api.views_list()) v where v ->> 'name' = 'POZ — podstawowa opieka zdrowotna')), 'CR403', null, 'member cannot delete a system view');
select is(api.tag_upsert('{"name":"Nowy tag","color":"#112233"}') ->> 'color', '#112233', 'member creates a tag');
select throws_ok($$select api.tag_upsert('{"name":"nowy TAG"}')$$, 'CR409', null, 'tag names are unique case-insensitively');
select throws_ok($$select api.tag_upsert('{"name":"x","color":"red"}')$$, 'CR422', null, 'bad colour: CR422');

-- contacts -------------------------------------------------------------------------------------------------------------------------
select public.t_login('anna@example.test');
select is(api.contact_upsert(public.t_entry('P-00030'), '{"kind":"email","value":"  Nowy.Adres@Example.PL ","isPrimary":true}') ->> 'value', 'Nowy.Adres@Example.PL', 'CRM e-mail stored');
select is(api.lead_get(public.t_entry('P-00030')) -> 'row' ->> 'email', 'Nowy.Adres@Example.PL', 'CRM primary e-mail replaces the register one in the row');
select throws_ok(format($$select api.contact_upsert(%s, '{"kind":"email","value":"bez-malpy"}')$$, public.t_entry('P-00030')), 'CR422', null, 'invalid CRM e-mail: CR422');
select is(api.contact_upsert(public.t_entry('P-00030'), '{"kind":"phone","value":"600 000 030","source":"register","status":"invalid"}') ->> 'status', 'invalid', 'override marks the register phone invalid');
select is(api.lead_get(public.t_entry('P-00030')) -> 'row' ->> 'tel', null, 'an invalid register phone disappears from the row');
select is(api.contact_delete((api.lead_get(public.t_entry('P-00030')) -> 'contacts' -> 1 ->> 'id')::int) ->> 'deleted', 'true', 'contact deleted');

-- statuses / members / settings (owner) -----------------------------------------------------------------------------------------------
select public.t_login('owner@example.test');
select is(api.status_upsert('{"name":"Do wyceny","stage":"open","sort":55}') ->> 'name', 'Do wyceny', 'owner adds a status');
select throws_ok($$select api.status_upsert('{"name":"do wyceny"}')$$, 'CR409', null, 'status names are unique case-insensitively');
select throws_ok($$select api.status_upsert('{"id":1,"isDefault":false}')$$, 'CR422', null, 'the default status cannot be un-defaulted directly');
select is((api.status_upsert('{"id":2,"isDefault":true}') ->> 'isDefault')::boolean, true, 'another status becomes the default');
select is((api.status_upsert('{"id":1,"isDefault":true}') ->> 'isDefault')::boolean, true, 'and back');
select throws_ok($$select api.status_delete(1::smallint, 2::smallint)$$, 'CR422', null, 'the default status cannot be deleted');
select is((api.status_delete(3::smallint, 2::smallint) ->> 'reassigned')::int, 2, 'status delete moves its leads');
select is(public.t_int($$select count(*)::int from crm.lead where status_id = 3$$), 0, 'no lead keeps the deleted status');
select throws_ok($$select api.member_upsert('{"id":1,"email":"owner@example.test","role":"member","displayName":"x"}')$$, 'CR424', null, 'the last owner cannot be demoted');
select throws_ok($$select api.member_upsert('{"id":1,"email":"owner@example.test","role":"owner","displayName":"x","active":false}')$$, 'CR424', null, 'the last owner cannot be deactivated');
select is(api.member_upsert('{"email":"Nowy@Example.test","role":"member","displayName":"Nowy"}') ->> 'email', 'nowy@example.test', 'new member e-mail is lower-cased');
select throws_ok($$select api.member_upsert('{"email":"nowy@example.test","role":"member","displayName":"Dubel"}')$$, 'CR409', null, 'duplicate e-mail: CR409');
select throws_ok($$select api.member_upsert('{"email":"zly","role":"member","displayName":"x"}')$$, 'CR422', null, 'bad e-mail: CR422');
select is(api.setting_set('ui.staleDays', '40') ->> 'ok', 'true', 'owner sets a setting');
select is(api.ref_data() -> 'settings' ->> 'staleDays', '40', 'public settings reflect it');
select throws_ok($$select api.setting_set('ui.staleDays', '"abc"')$$, 'CR422', null, 'wrong setting type: CR422');
select throws_ok($$select api.setting_set('val.minConfidence', '150')$$, 'CR422', null, 'setting out of range: CR422');
select throws_ok($$select api.setting_set('nope', '1')$$, 'CR422', null, 'unknown setting key: CR422');
select throws_ok($$select api.setting_set('val.params', '{"staleBefore":"2023-11-10"}')$$, 'CR422', null, 'incomplete val.params: CR422');
select is(api.generic_domain_upsert('Moja-Siec.Example', 'generic', null) ->> 'ok', 'true', 'owner adds a generic domain');
select is((select count(*)::int from jsonb_array_elements(api.val_decisions() -> 'genericDomains') d where d ->> 'domain' = 'moja-siec.example'), 1, 'domain is lower-cased and returned for the worker');
select is(api.generic_domain_upsert('moja-siec.example', null, null) ->> 'ok', 'true', 'owner removes it');
select is(api.tag_delete(1::smallint) ->> 'deleted', 'true', 'owner deletes a tag');
select is(public.t_int($$select count(*)::int from crm.lead where tags @> array[1::smallint]$$), 0, 'deleting a tag removes it from the leads');

select * from finish();
rollback;
