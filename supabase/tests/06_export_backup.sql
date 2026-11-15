-- Owner-only export rows and the CRM backup / restore round trip (synthetic data only).
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
create function public.t_text(p_sql text) returns text language plpgsql security definer set search_path = '' as $$
declare v text; begin execute p_sql into v; return v; end $$;
create function public.t_reg_key(p_ks text) returns text language sql security definer set search_path = '' as $$ select private.reg_key(e) from crm.reg_entry e where e.ks = p_ks $$;
-- delete all CRM work tables (not the allowlist/statuses), to prove a restore from the backup file alone
create function public.t_wipe_work() returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from crm.list_member; delete from crm.lead_contact; delete from crm.task; delete from crm.activity; delete from crm.lead;
end $$;

select public.t_login('owner@example.test');

-- CRM work to back up ---------------------------------------------------------------------------------------------------------
select lives_ok(format($$select api.lead_update(%s, 0, '{"statusId":4,"ownerId":2,"tags":[1,2],"shortName":"Krótka","dnc":true,"dncReason":"test","nextStepAt":"2031-05-05","validation":2,"checklist":{"podmiotDziala":true}}')$$, public.t_entry('P-00050')), 'lead with many CRM fields');
select lives_ok(format($$select api.activity_add(%s, '{"type":"sms","outcome":"wyslano","body":"Wiadomość","contactValue":"600000050"}')$$, public.t_entry('P-00050')), 'activity');
select lives_ok(format($$select api.contact_upsert(%s, '{"kind":"person","personName":"Jan Testowy","personRole":"Dyrektor"}')$$, public.t_entry('P-00050')), 'person contact');
select lives_ok(format($$select api.task_upsert('{"title":"Zadanie do kopii","dueDate":"2031-06-01","entryId":%s}')$$, public.t_entry('P-00050')), 'task');
select lives_ok(format($$select api.leads_bulk('{"entryIds":[%s]}', '{"action":"add_to_list","listId":1}')$$, public.t_entry('P-00050')), 'list membership');

-- export ------------------------------------------------------------------------------------------------------------------------
select is(api.export_begin(format('{"entryIds":[%s,%s]}', public.t_entry('P-00050'), public.t_entry('P-00051'))::jsonb, 'csv', '{}') ->> 'total', '1', 'do-not-contact lead is excluded by default');
select is(api.export_begin(format('{"entryIds":[%s,%s]}', public.t_entry('P-00050'), public.t_entry('P-00051'))::jsonb, 'csv', '{"includeDnc":true}') ->> 'total', '2', 'includeDnc brings it back');
select is(api.export_begin('{"filter":{"kind":"p","sel":{"p.grp":["0"]}}}', 'customerio', '{}') ->> 'total', '59', 'filter export: 60 minus the do-not-contact lead (P-00050 is in group 0)');
select throws_ok($$select api.export_begin('{"entryIds":[1]}', 'xml', '{}')$$, 'CR422', null, 'unknown format: CR422');
select throws_ok($$select api.export_begin('{}', 'csv', '{}')$$, 'CR422', null, 'target without entryIds or filter: CR422');
select throws_ok($$select api.export_page(999999, 0, 10)$$, 'CR404', null, 'unknown export: CR404');
create temp table ctx (k text primary key, v text);
grant all on ctx to public;
insert into ctx values ('exp', api.export_begin(format('{"entryIds":[%s,%s]}', public.t_entry('P-00050'), public.t_entry('P-00051'))::jsonb, 'csv', '{"includeDnc":true}') ->> 'exportId');
select throws_ok(format($$select api.export_page(%s, 0, 5001)$$, (select v from ctx where k = 'exp')), 'CR413', null, 'export page above 5000: CR413');
select is(jsonb_array_length(api.export_page((select v::int from ctx where k = 'exp'), 0, 10)), 2, 'both rows returned');
select is(jsonb_array_length(api.export_page((select v::int from ctx where k = 'exp'), 1, 10)), 1, 'offset works');
select is((select array_agg(k order by k collate "C") from jsonb_object_keys(api.export_page((select v::int from ctx where k = 'exp'), 0, 1) -> 0) k),
  array['dnc','email','emails','entityType','firstImportedAt','formType','forma','id','inRegister','keyHash','kind','kod','lastContactAt','miasto','mobile','name','nextStepAt','nip','nk','nz','owner','phones','qEmail','regKey','shortName','spec1','src','stan','status','tags','tel','ulica','validation','woj','wpis','www'],
  'ExportRow has exactly the contract keys');
select ok((api.export_page((select v::int from ctx where k = 'exp'), 0, 1) -> 0 ->> 'keyHash') ~ '^[0-9a-f]{16}$', 'key hash is 16 hex digits');
-- backup ------------------------------------------------------------------------------------------------------------------------
select throws_ok($$select api.backup_export('nope', 0, 10)$$, 'CR422', null, 'unknown backup table: CR422');
select throws_ok($$select api.backup_export('lead', 0, 5001)$$, 'CR413', null, 'backup page above 5000: CR413');
select ok((select bool_and(api.backup_export(t, 0, 5000) is not null) from unnest(array['team_member','lead_status','tag','app_setting','lead','lead_contact','activity','task','template','list','list_member','saved_view','network','network_member','val_proposal','val_decision','generic_domain']) t), 'every contract backup table exports');
select is((select count(*)::int from jsonb_array_elements(api.backup_export('lead', 0, 5000)) r where r ? 'regKey'), jsonb_array_length(api.backup_export('lead', 0, 5000)), 'lead rows reference entries by regKey');
select is((select count(*)::int from unnest(array['lead','lead_contact','activity','task','list_member']) t,
  jsonb_array_elements(api.backup_export(t, 0, 5000)) r where r ? 'entryId' or r ? 'entry_id' or r ? 'id'), 0, 'no internal ids of register entries in the backup');
select is((select r ->> 'status' from jsonb_array_elements(api.backup_export('lead', 0, 5000)) r where r ->> 'regKey' like '%P-00050%'), 'Zainteresowany', 'statuses by name');
select is((select r ->> 'owner' from jsonb_array_elements(api.backup_export('lead', 0, 5000)) r where r ->> 'regKey' like '%P-00050%'), 'anna@example.test', 'members by e-mail');
select ok((select position('Przychodnia' in api.backup_export('lead', 0, 5000)::text) = 0), 'no register names in the lead backup');

insert into ctx values ('lead', api.backup_export('lead', 0, 5000)::text), ('act', api.backup_export('activity', 0, 5000)::text),
  ('task', api.backup_export('task', 0, 5000)::text), ('contact', api.backup_export('lead_contact', 0, 5000)::text),
  ('lm', api.backup_export('list_member', 0, 5000)::text), ('nleads', jsonb_array_length(api.backup_export('lead', 0, 5000))::text),
  ('nact', jsonb_array_length(api.backup_export('activity', 0, 5000))::text);
select public.t_logout();
select public.t_wipe_work();
select public.t_login('owner@example.test');
select is(jsonb_array_length(api.backup_export('lead', 0, 5000)), 0, 'wiped');
select is(api.backup_restore('lead', (select v::jsonb from ctx where k = 'lead')) ->> 'inserted', (select v from ctx where k = 'nleads'), 'restore: leads inserted');
select is(api.backup_restore('lead', (select v::jsonb from ctx where k = 'lead')) ->> 'inserted', '0', 'restore twice: nothing inserted again');
select is(api.backup_restore('lead', (select v::jsonb from ctx where k = 'lead')) ->> 'skipped', (select v from ctx where k = 'nleads'), 'restore twice: all skipped');
select is(api.backup_restore('activity', (select v::jsonb from ctx where k = 'act')) ->> 'inserted', (select v from ctx where k = 'nact'), 'restore: activities inserted');
select is(api.backup_restore('activity', (select v::jsonb from ctx where k = 'act')) ->> 'inserted', '0', 'activities are not duplicated');
select is((api.backup_restore('task', (select v::jsonb from ctx where k = 'task')) ->> 'inserted')::int, jsonb_array_length((select v::jsonb from ctx where k = 'task')), 'restore: tasks');
select is((api.backup_restore('lead_contact', (select v::jsonb from ctx where k = 'contact')) ->> 'inserted')::int, jsonb_array_length((select v::jsonb from ctx where k = 'contact')), 'restore: contacts');
select is((api.backup_restore('list_member', (select v::jsonb from ctx where k = 'lm')) ->> 'inserted')::int, jsonb_array_length((select v::jsonb from ctx where k = 'lm')), 'restore: list members');
select is((select jsonb_agg(r - 'version') from jsonb_array_elements(api.backup_export('lead', 0, 5000)) r)::text, (select jsonb_agg(r - 'version') from jsonb_array_elements((select v::jsonb from ctx where k = 'lead')) r)::text, 'leads are identical after the round trip (version aside)');
select is((select jsonb_agg(r order by r::text) from jsonb_array_elements(api.backup_export('activity', 0, 5000)) r)::text, (select jsonb_agg(r order by r::text) from jsonb_array_elements((select v::jsonb from ctx where k = 'act')) r)::text, 'activities are identical after the round trip (order aside)');
select is(api.lead_get(public.t_entry('P-00050')) -> 'lead' ->> 'dncReason', 'test', 'the card shows the restored lead');
select is(api.backup_restore('lead', '[{"regKey":"Rpm|nie ma|X|1","status":"Nowy"}]') ->> 'unresolved', '1', 'an unknown register key is reported as unresolved');
-- SEC-08: an attach decision with an account key of the wrong shape is not restored
select is(api.backup_restore('val_decision', '[{"keyHash":"00000000000000ff","action":"attach","accountKey":"konto-X"}]') ->> 'inserted', '0', 'attach with a malformed account key is skipped');
select is(api.backup_restore('val_decision', '[{"keyHash":"00000000000000fe","action":"attach","accountKey":"n:1234567890"}]') ->> 'inserted', '1', 'attach with a well-formed key is restored');
select is(api.backup_restore('team_member', api.backup_export('team_member', 0, 5000)) ->> 'inserted', '0', 'existing members are skipped');
select is(api.backup_restore('tag', '[{"name":"Tag z kopii","color":"#abcdef"}]') ->> 'inserted', '1', 'a missing tag is restored');
select is(api.backup_restore('tag', '[{"name":"tag Z KOPII"}]') ->> 'inserted', '0', 'tag names match case-insensitively');
-- SEC-05: a file never creates owners, unknown setting keys are skipped, constraint violations are CR422, detach stores no key
select is(api.backup_restore('team_member', '[{"email":"nowy-wlasciciel@example.test","displayName":"Z kopii","role":"owner"}]') ->> 'inserted', '1', 'a missing member is restored');
select is(public.t_text($$select role from crm.team_member where email = 'nowy-wlasciciel@example.test'$$), 'member', 'SEC-05: a restored owner comes back as a member');
select is(api.backup_restore('app_setting', '[{"key":"nieznany.klucz","value":1}]') ->> 'inserted', '0', 'SEC-05: an unknown setting key is skipped');
select throws_ok(format($$select api.backup_restore('lead', %L)$$, jsonb_build_array(jsonb_build_object('regKey', public.t_reg_key('P-00051'), 'validation', 9))::text),
  'CR422', null, 'SEC-05: a value the table refuses (validation 9) is CR422, not a raw check violation');
select is(api.backup_restore('val_decision', '[{"keyHash":"00000000000000fd","action":"detach","accountKey":"<script>"}]') ->> 'inserted', '1', 'a detach decision is restored');
select is(public.t_text($$select coalesce(account_key, 'null') from crm.val_decision where key_hash = private.hash_from_hex('00000000000000fd')$$), 'null', 'SEC-05/08: a detach decision stores no account key text');
select throws_ok($$select api.backup_restore('nope', '[]')$$, 'CR422', null, 'unknown restore table: CR422');
select throws_ok($$select api.backup_restore('lead', '{}')$$, 'CR422', null, 'rows must be an array: CR422');

select * from finish();
rollback;
