-- Security matrix: anon / signed-in non-member / member / owner. Runs on the seeded local database (db reset).
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
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- structure ------------------------------------------------------------------------------------------------------
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'crm' and c.relkind = 'r' and not c.relrowsecurity), 0, 'RLS is enabled on every crm table');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'crm' and c.relkind = 'r'
             and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select')
                  or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'insert'))), 0,
          'neither anon nor authenticated can read or write any crm table');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'crm' and c.relkind = 'r' and exists (select 1 from pg_policy p where p.polrelid = c.oid)), 0,
          'no RLS policies exist (deny-all second wall)');
select ok(not has_schema_privilege('anon', 'crm', 'usage') and not has_schema_privilege('authenticated', 'crm', 'usage')
          and not has_schema_privilege('anon', 'private', 'usage') and not has_schema_privilege('authenticated', 'private', 'usage'),
          'crm and private schemas are not usable by API roles');
select ok(not has_schema_privilege('anon', 'api', 'usage') and has_schema_privilege('authenticated', 'api', 'usage'), 'api schema: authenticated only');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'api' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))), 0,
          'no api function is executable by anon or PUBLIC');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'api' and not has_function_privilege('authenticated', p.oid, 'execute')), 0, 'every api function is executable by authenticated');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'api' and (not p.prosecdef or p.proconfig is null or not ('search_path=""' = any (p.proconfig)))), 0,
          'every api function is SECURITY DEFINER with an empty search_path');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))), 0,
          'no private helper is executable by API roles');
select bag_eq($$select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api'$$,
  $$values ('me'),('ref_data'),('dict'),('leads_search'),('leads_count'),('leads_facets'),('lead_get'),('lead_timeline'),('lead_update'),
    ('leads_bulk'),('activity_add'),('activity_update'),('activity_delete'),('contact_upsert'),('contact_delete'),('tasks_list'),
    ('task_upsert'),('task_done'),('task_delete'),('today'),('templates_list'),('template_upsert'),('template_delete'),('lists_list'),
    ('list_upsert'),('list_delete'),('views_list'),('view_upsert'),('view_delete'),('val_summary'),('val_queue'),('val_proposal_get'),
    ('val_decide'),('val_account_link'),('val_decisions'),('networks_list'),('network_upsert'),('network_member_remove'),
    ('import_begin'),('import_state'),('import_labels'),('import_entries'),('import_derived'),('import_gone'),('import_proposals'),
    ('import_finish'),('import_abort'),('import_runs'),('import_changes'),('import_crm_work'),('export_begin'),('export_page'),
    ('backup_export'),('backup_restore'),('members_list'),('member_upsert'),('settings_get'),('setting_set'),('status_upsert'),
    ('status_delete'),('tag_upsert'),('tag_delete'),('generic_domain_upsert'),('db_usage')$$,
  'the api schema holds exactly the contract RPCs (plus import_crm_work)');

-- anon ----------------------------------------------------------------------------------------------------------------
select public.t_logout();
set local role anon;
select throws_ok($$select api.me()$$, '42501', null, 'anon cannot call api.me');
select throws_ok($$select api.leads_search('{}', null, 0, 10)$$, '42501', null, 'anon cannot call api.leads_search');
select throws_ok($$select * from crm.reg_entry$$, '42501', null, 'anon cannot read crm tables');
reset role;

-- signed in, no JWT subject / not on the allowlist ---------------------------------------------------------------------------
select set_config('role', 'authenticated', true);
select throws_ok($$select api.me()$$, 'CR401', null, 'authenticated without a session subject: CR401');
select public.t_login('stranger@example.test');
select throws_ok($$select api.me()$$, 'CR402', null, 'non-member: CR402 on api.me');
select throws_ok($$select api.ref_data()$$, 'CR402', null, 'non-member: CR402 on api.ref_data');
select throws_ok($$select api.leads_count('{}')$$, 'CR402', null, 'non-member: CR402 on api.leads_count');
select throws_ok($$select * from crm.team_member$$, '42501', null, 'non-member cannot read tables directly');

-- inactive member ---------------------------------------------------------------------------------------------------------
select public.t_logout();
update crm.team_member set active = false where email = 'piotr@example.test';
select public.t_login('piotr@example.test');
select throws_ok($$select api.me()$$, 'CR402', null, 'deactivated member: CR402 at once');
select public.t_logout();
update crm.team_member set active = true where email = 'piotr@example.test';

-- member: every owner-only RPC answers CR403 ------------------------------------------------------------------------------------
select public.t_login('anna@example.test');
select lives_ok($$select api.me()$$, 'member: api.me works and links user_id by e-mail');
select public.t_logout();
select is((select user_id from crm.team_member where email = 'anna@example.test'), md5('anna@example.test')::uuid, 'first sign-in stored user_id');
select public.t_login('anna@example.test');
select throws_ok(sql, 'CR403', null, 'member denied: ' || label) from (values
  ('db_usage', $$select api.db_usage()$$),
  ('import_begin', $$select api.import_begin('{}')$$),
  ('import_state', $$select api.import_state(0, 10)$$),
  ('import_labels', $$select api.import_labels(1, '[]')$$),
  ('import_entries', $$select api.import_entries(1, '[]')$$),
  ('import_derived', $$select api.import_derived(1, '[]')$$),
  ('import_gone', $$select api.import_gone(1, '[]')$$),
  ('import_proposals', $$select api.import_proposals(1, '[]', true)$$),
  ('import_finish', $$select api.import_finish(1, '{}')$$),
  ('import_abort', $$select api.import_abort(1, 'x')$$),
  ('import_runs', $$select api.import_runs()$$),
  ('import_changes', $$select api.import_changes(1, 'new', false, 0, 10)$$),
  ('import_crm_work', $$select api.import_crm_work('[]')$$),
  ('export_begin', $$select api.export_begin('{"entryIds":[1]}', 'csv', '{}')$$),
  ('export_page', $$select api.export_page(1, 0, 10)$$),
  ('backup_export', $$select api.backup_export('lead', 0, 10)$$),
  ('backup_restore', $$select api.backup_restore('lead', '[]')$$),
  ('members_list', $$select api.members_list()$$),
  ('member_upsert', $$select api.member_upsert('{"email":"x@example.test","role":"member","displayName":"X"}')$$),
  ('settings_get', $$select api.settings_get()$$),
  ('setting_set', $$select api.setting_set('ui.staleDays', '10')$$),
  ('status_upsert', $$select api.status_upsert('{"name":"Test"}')$$),
  ('status_delete', $$select api.status_delete(2::smallint, 1::smallint)$$),
  ('tag_delete', $$select api.tag_delete(1::smallint)$$),
  ('generic_domain_upsert', $$select api.generic_domain_upsert('example.org', 'free', null)$$),
  ('val_decisions', $$select api.val_decisions()$$)
) as t(label, sql);

-- owner: the same calls work ----------------------------------------------------------------------------------------------
select public.t_login('owner@example.test');
select lives_ok($$select api.members_list()$$, 'owner: members_list');
select lives_ok($$select api.db_usage()$$, 'owner: db_usage');
select lives_ok($$select api.settings_get()$$, 'owner: settings_get');
select lives_ok($$select api.import_runs()$$, 'owner: import_runs');

-- SEC-10: a null id gives a CR code, not 22004 'RAISE statement option cannot be null'
select throws_ok($$select api.lead_get(null)$$, 'CR404', null, 'SEC-10: lead_get(null) is CR404');
select throws_ok($$select api.val_decide(null, '{"decision":"accept"}')$$, 'CR404', null, 'SEC-10: val_decide(null) is CR404');
select public.t_logout();
-- SEC-14: every view in the app schemas is security_invoker
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'v' and n.nspname in ('crm', 'private', 'api')
             and not coalesce(c.reloptions @> array['security_invoker=true'], false)), 0, 'SEC-14: no view without security_invoker');

select * from finish();
rollback;
