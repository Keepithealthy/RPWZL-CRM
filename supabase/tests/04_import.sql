-- Import and monthly refresh: idempotency, diff/history, CRM data untouched, gone/returned, proposals, guards.
-- All rows are synthetic (generated below).
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
create function public.t_text(p_sql text) returns text language plpgsql security definer set search_path = '' as $$
declare v text; begin execute p_sql into v; return v; end $$;
create function public.t_entry(p_ks text) returns int language sql security definer set search_path = '' as $$ select id from crm.reg_entry where ks = p_ks $$;
create function public.t_keyhash(p_reg_key text) returns text language sql security definer set search_path = '' as $$ select private.hex16(private.key_hash_of(p_reg_key)) $$;
create function public.t_hash(p_ks text) returns text language sql security definer set search_path = '' as $$ select private.hex16(key_hash) from crm.reg_entry where ks = p_ks $$;

-- A synthetic ImportEntryRow (contract.ts). h_all is derived from the content so changed content changes the hash.
create function public.t_row(p_n int, p_name text default null, p_email text default null, p_tel text default '227770000',
                             p_stan text default '2026-05-01', p_woj text default 'mazowieckie', p_detail text default 'v1',
                             p_src text default 'Rpm', p_nip text default null) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ks text := 'T-' || lpad(p_n::text, 4, '0');
  v_org text := 'Organ testowy';
  v_key text := p_src || '|' || v_org || '|' || v_ks || '|1';
  v_hex text := private.hex16(private.key_hash_of(v_key));
  v_nip text := coalesce(p_nip, '1000000' || lpad(p_n::text, 3, '0'));
  v_kind text := case when p_src = 'Rpm' then 'p' else 'r' end;
  v_content text := coalesce(p_name, '') || coalesce(p_email, '') || p_tel || p_stan || p_woj || p_detail;
begin
  return jsonb_build_object(
    'keyHash', v_hex, 'regKey', v_key, 'kind', v_kind, 'src', p_src, 'org', v_org, 'ks', v_ks, 'kseq', 1,
    'name', coalesce(p_name, 'Test ' || p_n), 'nip', v_nip, 'email', p_email, 'tel', p_tel, 'www', null,
    'emails', case when p_email is null then '[]'::jsonb else jsonb_build_array(p_email) end,
    'miasto', 'Testowo', 'kod', '00-001', 'wpis', '2026-01-10', 'stan', p_stan, 'nz', 1, 'nk', 2,
    'facets', jsonb_build_object(case when v_kind = 'p' then 'p.status' else 'r.status' end, jsonb_build_array('aktywny'),
                                 case when v_kind = 'p' then 'p.woj' else 'r.woj' end, jsonb_build_array(p_woj)),
    'derived', jsonb_build_object('nipStatus', 4, 'entityType', case when v_kind = 'p' then 1 else 4 end, 'accountKey', 'e:' || v_hex,
      'accountSize', 1, 'isAccountPrimary', true, 'telShared', null, 'qEmail', 80, 'qPhone', 85, 'qflags', 0,
      'mobile', null, 'telNorm', p_tel, 'nums', jsonb_build_array(p_tel), 'formType', null, 'spec1', 0),
    'rec', jsonb_build_object('emails', case when p_email is null then '[]'::jsonb else jsonb_build_array(p_email) end,
      'phones', jsonb_build_array(p_tel), 'ulica', 'ul. Testowa 1', 'd', jsonb_build_object('ks', v_ks, 'v', p_detail)),
    'hAll', (('x' || substr(md5(v_key || v_content), 1, 15))::bit(60)::bigint)::text, 'hContact', '1', 'hDerived', '1');
end $$;

create function public.t_begin(p_sources jsonb default '[{"id":"Rpm","records":3,"reportDate":"2026-11-30","today":null,"bad":0}]') returns int
language plpgsql as $$
begin
  return (api.import_begin(jsonb_build_object('fileName', 'test.json.gz', 'fileSha256', 'abc', 'indexVersion', 2, 'createdAt', null,
    'today', '2026-12-01', 'reportDate', '2026-11-30', 'sources', p_sources, 'hashVersion', 1, 'preview', '{}'::jsonb)) ->> 'runId')::int;
end $$;

-- CRM tables fingerprint (everything the team enters; proposals/networks excluded on purpose: networks are CRM, proposals are import output)
create function public.t_crm_fingerprint() returns text language sql security definer set search_path = '' as $$
  select md5(
    coalesce((select jsonb_agg(to_jsonb(x) order by entry_id) from crm.lead x)::text, '') ||
    coalesce((select jsonb_agg(to_jsonb(x) order by id) from crm.activity x)::text, '') ||
    coalesce((select jsonb_agg(to_jsonb(x) order by id) from crm.task x)::text, '') ||
    coalesce((select jsonb_agg(to_jsonb(x) order by id) from crm.lead_contact x)::text, '') ||
    coalesce((select jsonb_agg(to_jsonb(x) order by list_id, entry_id) from crm.list_member x)::text, '') ||
    coalesce((select jsonb_agg(to_jsonb(x) order by key_hash) from crm.val_decision x)::text, '') ||
    coalesce((select jsonb_agg(to_jsonb(x) order by account_key) from crm.network_member x)::text, '') ||
    coalesce((select jsonb_agg(to_jsonb(x) order by id) from crm.saved_view x)::text, ''))
$$;

select public.t_login('owner@example.test');

-- guards -------------------------------------------------------------------------------------------------------------------------
select throws_ok($$select api.import_begin('{"indexVersion":1,"sources":[],"reportDate":"2026-01-01"}')$$, 'CR422', null, 'index version 1 is refused');
select public.t_login('anna@example.test');
select throws_ok($$select api.import_begin('{}')$$, 'CR403', null, 'member cannot import');
select public.t_login('owner@example.test');

-- run A: first import of 4 entries -------------------------------------------------------------------------------------------------
create temp table ctx (k text primary key, v text);
grant all on ctx to public;
insert into ctx values ('runA', public.t_begin('[{"id":"Rpm","records":3,"reportDate":"2026-11-30","today":null,"bad":0},{"id":"Rpz","records":1,"reportDate":"2026-11-30","today":null,"bad":0}]')::text);
select ok((select v::int from ctx where k = 'runA') > 1, 'import_begin returns a run id');
select throws_ok($$select public.t_begin()$$, 'CR423', null, 'a second concurrent run is locked out (CR423)');
select is(api.import_labels((select v::int from ctx where k = 'runA'), '[{"facet":"p.woj","val":"mazowieckie","label":"Mazowieckie"},{"facet":"p.spec","val":"9999","label":"Poradnia testowa"}]') ->> 'upserted', '2', 'labels inserted/updated');
select is(api.import_labels((select v::int from ctx where k = 'runA'), '[{"facet":"p.woj","val":"mazowieckie","label":"Mazowieckie"},{"facet":"p.spec","val":"9999","label":"Poradnia testowa"}]') ->> 'upserted', '0', 'the same labels again change nothing');
select throws_ok(format($$select api.import_labels(%s, '[{"facet":"bogus","val":"x","label":"y"}]')$$, (select v from ctx where k = 'runA')), 'CR422', null, 'unknown label facet: CR422');

select is(api.import_entries((select v::int from ctx where k = 'runA')::int,
  jsonb_build_array(public.t_row(1, p_name => 'Alfa Przychodnia', p_email => 'alfa@alfa-test.example'), public.t_row(2), public.t_row(3, p_tel => '228880003'),
                    public.t_row(4, p_src => 'Rpz', p_tel => '501000004'))), '{"inserted": 4, "updated": 0, "returned": 0}'::jsonb, 'first batch: 4 inserted');
insert into ctx values ('seq_before', public.t_text($$select pg_sequence_last_value(pg_get_serial_sequence('crm.reg_dict', 'id'))::text$$));
insert into ctx values ('cnt_before', public.t_int($$select count(*)::int from crm.reg_entry$$)::text);
select is(api.import_entries((select v::int from ctx where k = 'runA')::int,
  jsonb_build_array(public.t_row(1, p_name => 'Alfa Przychodnia', p_email => 'alfa@alfa-test.example'), public.t_row(2), public.t_row(3, p_tel => '228880003'),
                    public.t_row(4, p_src => 'Rpz', p_tel => '501000004'))), '{"inserted": 0, "updated": 0, "returned": 0}'::jsonb, 'the same batch again is idempotent');
select is(public.t_int($$select count(*)::int from crm.reg_entry$$)::text, (select v from ctx where k = 'cnt_before'), 'no duplicate rows after the retry');
select is(public.t_text($$select pg_sequence_last_value(pg_get_serial_sequence('crm.reg_dict', 'id'))::text$$), (select v from ctx where k = 'seq_before'), 'retries burn no dictionary ids');
select is(public.t_int($$select count(*)::int from crm.reg_change$$), 0, 'a first import writes no history rows');
select is(api.lead_get(public.t_entry('T-0001')) -> 'rec' -> 'd' ->> 'v', 'v1', 'detail block readable through lead_get');
select is(api.lead_get(public.t_entry('T-0001')) -> 'facets' -> 'p.woj', '["mazowieckie"]'::jsonb, 'facet values come back by name');
select is(api.lead_get(public.t_entry('T-0004')) ->> 'regKey', 'Rpz|Organ testowy|T-0004|1', 'register key is rebuilt');
select is(api.import_proposals((select v::int from ctx where k = 'runA')::int,
  jsonb_build_array(jsonb_build_object('kind', 'email', 'matchValue', 'shared@alfa-test.example', 'confidence', 85, 'groupKey', 'g1', 'members', jsonb_build_array('e:' || public.t_hash('T-0001'), 'e:' || public.t_hash('T-0002'))),
                    jsonb_build_object('kind', 'phone', 'matchValue', '227770000', 'confidence', 50, 'groupKey', 'g2', 'members', jsonb_build_array('e:' || public.t_hash('T-0002'), 'e:' || public.t_hash('T-0003')))), false),
  '{"upserted": 2, "reopened": 0, "staled": 0}'::jsonb, 'proposals stored');
select is(api.import_finish((select v::int from ctx where k = 'runA'), '{"total":4,"new":4,"changed":0,"changedContact":0,"returned":0,"gone":0,"unchanged":0,"derivedOnly":0,"rejected":0}') ->> 'status', 'applied', 'run A applied');
select throws_ok(format($$select api.import_entries(%s, '[]')$$, (select v from ctx where k = 'runA')), 'CR423', null, 'a finished run accepts no more batches (CR423)');
select is((api.ref_data() -> 'lastImport' ->> 'reportDate'), '2026-11-30', 'last import is the latest applied run');

-- state listing --------------------------------------------------------------------------------------------------------------------
select is(array_length(regexp_split_to_array((api.import_state(public.t_entry('T-0001') - 1, 100) ->> 'data'), E'\n'), 1), 4, 'import_state lists the four new entries after the given id');
select is(array_length(string_to_array(split_part(api.import_state(public.t_entry('T-0001') - 1, 100) ->> 'data', E'\n', 1), E'\t'), 1), 7, 'a state line has 7 tab separated fields');
select is(api.import_state(public.t_entry('T-0001') - 1, 2) ->> 'nextAfterId', (public.t_entry('T-0001') + 1)::text, 'a full page returns the next cursor');
select is(api.import_state(public.t_entry('T-0001') - 1, 100) -> 'nextAfterId', 'null'::jsonb, 'a short page returns null');
select throws_ok($$select api.import_state(0, 20001)$$, 'CR413', null, 'state page above 20000: CR413');

-- CRM work, then run B (refresh) -------------------------------------------------------------------------------------------------
select public.t_login('anna@example.test');
select lives_ok(format($$select api.lead_update(%s, 0, '{"statusId":4,"ownerId":2,"tags":[1]}')$$, public.t_entry('T-0001')), 'CRM edits on a register entry');
select lives_ok(format($$select api.activity_add(%s, '{"type":"call","outcome":"rozmowa","body":"notatka"}')$$, public.t_entry('T-0001')), 'activity on it');
select lives_ok(format($$select api.task_upsert('{"title":"Zadanie testowe","dueDate":"2030-01-01","entryId":%s}')$$, public.t_entry('T-0003')), 'task on another entry');
select public.t_login('owner@example.test');
insert into ctx values ('crm_before', public.t_crm_fingerprint());
insert into ctx values ('runB', public.t_begin()::text);
select is(api.import_entries((select v::int from ctx where k = 'runB'),
  jsonb_build_array(public.t_row(1, p_name => 'Alfa Przychodnia Nowa Nazwa', p_email => 'alfa@alfa-test.example', p_tel => '229990001', p_detail => 'v2'),
                    public.t_row(2), public.t_row(5, p_woj => 'pomorskie'))), '{"inserted": 1, "updated": 1, "returned": 0}'::jsonb, 'refresh: 1 new, 1 changed, 1 unchanged');
select is((select fields from (select public.t_int($$select fields from crm.reg_change where entry_id = (select id from crm.reg_entry where ks = 'T-0001')$$) as fields) x), 1 | 2 | 256, 'history marks contact, name and detail groups');
select is(public.t_text($$select old ->> 'tel' from crm.reg_change where entry_id = (select id from crm.reg_entry where ks = 'T-0001')$$), '227770000', 'history keeps the old phone');
select is(public.t_text($$select old ->> 'name' from crm.reg_change where entry_id = (select id from crm.reg_entry where ks = 'T-0001')$$), 'Alfa Przychodnia', 'history keeps the old name');
select is(public.t_int($$select count(*)::int from crm.reg_change where entry_id = (select id from crm.reg_entry where ks = 'T-0002')$$), 0, 'unchanged entry has no history row');
select is(api.lead_get(public.t_entry('T-0001')) -> 'rec' -> 'd' ->> 'v', 'v2', 'changed detail replaced in its block');
select is(api.lead_get(public.t_entry('T-0002')) -> 'rec' -> 'd' ->> 'v', 'v1', 'untouched detail kept');
select is(api.import_gone((select v::int from ctx where k = 'runB'), jsonb_build_array(public.t_hash('T-0003'))) ->> 'gone', '1', 'entry of a fully contained source: gone');
select is(api.import_gone((select v::int from ctx where k = 'runB'), jsonb_build_array(public.t_hash('T-0004'))) ->> 'gone', '0', 'entry of a source absent from the file is never gone');
select is(api.import_gone((select v::int from ctx where k = 'runB'), jsonb_build_array(public.t_hash('T-0003'))) ->> 'gone', '0', 'gone is idempotent');
select is(api.import_derived((select v::int from ctx where k = 'runB'), jsonb_build_array(jsonb_build_object('keyHash', public.t_hash('T-0002'),
  'derived', jsonb_build_object('nipStatus', 1, 'entityType', 1, 'accountKey', 'n:1000000002', 'accountSize', 1, 'isAccountPrimary', true, 'telShared', null, 'qEmail', 90, 'qPhone', 85, 'qflags', 0),
  'hDerived', '777'))) ->> 'updated', '1', 'derived-only update');
select is(public.t_int($$select nip_status::int from crm.reg_entry where ks = 'T-0002'$$), 1, 'derived values stored');
select is(api.import_proposals((select v::int from ctx where k = 'runB')::int,
  jsonb_build_array(jsonb_build_object('kind', 'email', 'matchValue', 'shared@alfa-test.example', 'confidence', 85, 'groupKey', 'g1', 'members', jsonb_build_array('e:' || public.t_hash('T-0001'), 'e:' || public.t_hash('T-0002')))), true),
  '{"upserted": 1, "reopened": 0, "staled": 1}'::jsonb, 'final call stales the open e-mail proposal of the seed (kind produced, not sent again); phone proposals stay (kind not produced)');
select is(public.t_int($$select count(*)::int from crm.val_proposal where kind = 'phone' and status = 0$$) > 0, true, 'open proposals of kinds this run did not produce are kept');
select is(public.t_crm_fingerprint(), (select v from ctx where k = 'crm_before'), 'the refresh never touched CRM-entered data');
select is(api.import_finish((select v::int from ctx where k = 'runB'), '{"total":3,"new":1,"changed":1,"changedContact":1,"returned":0,"gone":1,"unchanged":1,"derivedOnly":1,"rejected":0}') ->> 'status', 'applied', 'run B applied');

-- run report ------------------------------------------------------------------------------------------------------------------------
select is(jsonb_array_length(api.import_changes((select v::int from ctx where k = 'runB'), 'changed', false, 0, 50)), 1, 'changes: one changed entry');
select is(api.import_changes((select v::int from ctx where k = 'runB'), 'changed', false, 0, 50) -> 0 -> 'fields', '["contact","name","detail"]'::jsonb, 'changed groups by name');
select is(jsonb_array_length(api.import_changes((select v::int from ctx where k = 'runB'), 'new', false, 0, 50)), 1, 'changes: one new entry');
select is(jsonb_array_length(api.import_changes((select v::int from ctx where k = 'runB'), 'gone', false, 0, 50)), 1, 'changes: one gone entry');
select is(jsonb_array_length(api.import_changes((select v::int from ctx where k = 'runB'), 'gone', true, 0, 50)), 1, 'gone entry with CRM work (a task) passes the CRM filter');
select is(jsonb_array_length(api.import_changes((select v::int from ctx where k = 'runB'), 'new', true, 0, 50)), 0, 'new entry without CRM work is filtered out');
select is(api.import_crm_work(jsonb_build_array(public.t_hash('T-0001'), public.t_hash('T-0002'), public.t_hash('T-0003'))), jsonb_build_array(public.t_hash('T-0001'), public.t_hash('T-0003')), 'import_crm_work names the leads with work');
select is((api.lead_timeline(public.t_entry('T-0001'), 'entry', null, 50) @> '[{"type":"register_changed"}]'::jsonb), true, 'register change appears in the timeline');
select is((api.lead_timeline(public.t_entry('T-0003'), 'entry', null, 50) @> '[{"type":"register_gone"}]'::jsonb), true, 'gone appears in the timeline');
select is((api.leads_search('{}', null, 0, 1) is not null), true, 'list works after the refresh');
select is((api.leads_count('{"q":"T-0003"}') ->> 'total')::int, 0, 'default "W rejestrze: tak" hides gone entries');
select is((api.leads_count('{"inRegister":"no"}') ->> 'total')::int, 1, 'gone entries are found with inRegister no');

-- run C: the gone entry returns ----------------------------------------------------------------------------------------------------
insert into ctx values ('runC', public.t_begin()::text);
select is(api.import_entries((select v::int from ctx where k = 'runC'), jsonb_build_array(public.t_row(3, p_tel => '228880003'))), '{"inserted": 0, "updated": 0, "returned": 1}'::jsonb, 'a gone entry that reappears counts as returned');
select is(public.t_int($$select change::int from crm.reg_change where entry_id = (select id from crm.reg_entry where ks = 'T-0003') and run_id = (select max(id) from crm.import_run)$$), 2, 'history row marks it returned');
select is(public.t_text($$select in_register::text from crm.reg_entry where ks = 'T-0003'$$), 'true', 'back in the register');
select is(api.import_abort((select v::int from ctx where k = 'runC'), 'test abort') ->> 'status', 'aborted', 'abort marks the run');
select is(api.import_abort((select v::int from ctx where k = 'runC'), 'again') ->> 'status', 'aborted', 'aborting twice is harmless');

-- row validation and limits ----------------------------------------------------------------------------------------------------------
insert into ctx values ('runD', public.t_begin()::text);
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9) || '{"kind":"r"}'))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'kind and src disagree: CR422');
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9) || '{"regKey":"Rpm|x|T-0009|1"}'))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'keyHash must match regKey: CR422');
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9) || '{"hAll":"abc"}'))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'bad hash: CR422');
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9) || jsonb_build_object('facets', jsonb_build_object('p.bogus', jsonb_build_array('x')))))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'unknown facet: CR422');
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9) || jsonb_build_object('ks', '')))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'empty book number: CR422');
select throws_ok(format($$select api.import_entries(%s, (select jsonb_agg(public.t_row(1)) from generate_series(1, 1001)))$$, (select v from ctx where k = 'runD')), 'CR413', null, 'more than 1000 rows: CR413');
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9) || '{"regKey":null}'))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'regKey is required: CR422');
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9) || '{"org":"Inny organ"}'))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'regKey parts must equal the row''s src/org/ks/kseq: CR422');
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9) || jsonb_build_object('email', repeat('a', 501))))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'e-mail above its cap: CR422');
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9) || jsonb_build_object('emails', (select jsonb_agg('x' || g || '@example.test') from generate_series(1, 51) g))))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'more than 50 e-mails: CR422');
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9), public.t_row(9)))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'the same keyHash twice in one batch: CR422, not a raw unique violation');
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9) || jsonb_build_object('derived', (public.t_row(9) -> 'derived') || '{"accountKey":"<img src=x>"}')))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'account key of the wrong shape: CR422');
select is(public.t_int($$select count(*)::int from crm.reg_entry where ks = 'T-0009'$$), 0, 'rejected rows leave nothing behind');
-- stored attach / detach decisions are enforced by the database, not only by the browser worker (SEC-02)
select is(api.val_account_link(public.t_entry('T-0002'), 'detach', null, null) is not null, true, 'a detach decision is stored');
select throws_ok(format($$select api.import_derived(%s, jsonb_build_array(jsonb_build_object('keyHash', public.t_hash('T-0002'),
  'derived', jsonb_build_object('nipStatus', 1, 'entityType', 1, 'accountKey', 'n:1000000002', 'accountSize', 1, 'isAccountPrimary', true, 'qflags', 0), 'hDerived', '888')))$$,
  (select v from ctx where k = 'runD')), 'CR422', null, 'import_derived refuses an account key that contradicts a detach decision');
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(2) || jsonb_build_object('derived', (public.t_row(2) -> 'derived') || '{"accountKey":"n:1000000002"}')))$$,
  (select v from ctx where k = 'runD')), 'CR422', null, 'import_entries refuses it too');
select throws_ok(format($$select api.import_derived(%s, jsonb_build_array(jsonb_build_object('keyHash', public.t_hash('T-0002'),
  'derived', jsonb_build_object('nipStatus', 1, 'entityType', 1, 'accountKey', '<img src=x onerror=alert(1)>', 'accountSize', 1, 'isAccountPrimary', true, 'qflags', 0), 'hDerived', '889')))$$,
  (select v from ctx where k = 'runD')), 'CR422', null, 'import_derived refuses an account key of the wrong shape');
select is(api.import_derived((select v::int from ctx where k = 'runD'), jsonb_build_array(jsonb_build_object('keyHash', public.t_hash('T-0002'),
  'derived', jsonb_build_object('nipStatus', 1, 'entityType', 1, 'accountKey', 'e:' || public.t_hash('T-0002'), 'accountSize', 1, 'isAccountPrimary', true, 'qflags', 0), 'hDerived', '890'))) ->> 'updated', '1',
  'the key that follows the decision is accepted');
-- SEC-07: facet values per row are capped, burned dictionary ids are reclaimed, a full dictionary is a CR error
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(9) || jsonb_build_object('facets',
  jsonb_build_object('p.spec', (select jsonb_agg('sec07-' || g) from generate_series(1, 2001) g)))))$$, (select v from ctx where k = 'runD')),
  'CR422', null, 'more than 2000 facet values in one row: CR422');
-- RD-6: the real register's largest podmioty carry up to 371 facet values (sum of rodzaje, grp, spec, dz, fn ...); a row of
-- about 400 values spread over five facets is accepted and every value is stored
select is(api.import_entries((select v::int from ctx where k = 'runD'), jsonb_build_array(public.t_row(11) || jsonb_build_object('facets',
  jsonb_build_object('p.status', '["aktywny"]'::jsonb, 'p.woj', '["mazowieckie"]'::jsonb,
    'p.rodzaje', (select jsonb_agg('rd6-rodzaj-' || g) from generate_series(1, 20) g),
    'p.grp', (select jsonb_agg('rd6-grp-' || g) from generate_series(1, 30) g),
    'p.spec', (select jsonb_agg('rd6-spec-' || g) from generate_series(1, 150) g),
    'p.dz', (select jsonb_agg('rd6-dz-' || g) from generate_series(1, 120) g),
    'p.fn', (select jsonb_agg('rd6-fn-' || g) from generate_series(1, 80) g))))) ->> 'inserted', '1',
  'RD-6: a row with 402 facet values is accepted');
select is(public.t_int($$select cardinality(fv) from crm.reg_entry where ks = 'T-0011'$$), 402, 'RD-6: all 402 facet values are stored on the entry');
select is(public.t_int($$select count(*)::int from crm.reg_dict where val like 'rd6-%'$$), 400, 'RD-6: the 400 new values are in the dictionary');
-- SEC-11: '|' separates the parts of regKey, so org and ks may not contain it
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(12) || jsonb_build_object('org', 'A|B', 'regKey', 'Rpm|A|B|T-0012|1',
  'keyHash', public.t_keyhash('Rpm|A|B|T-0012|1'))))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'SEC-11: org with | is refused');
-- SEC-09: derived values out of range and duplicate rows in import_derived are refused
select throws_ok(format($$select api.import_entries(%s, jsonb_build_array(public.t_row(12) || jsonb_build_object('derived', (public.t_row(12) -> 'derived') || '{"entityType":999}')))$$,
  (select v from ctx where k = 'runD')), 'CR422', null, 'SEC-09: entityType 999 is refused by import_entries');
select throws_ok(format($$select api.import_derived(%s, jsonb_build_array(jsonb_build_object('keyHash', public.t_hash('T-0002'),
  'derived', jsonb_build_object('nipStatus', 77, 'entityType', 1, 'accountKey', 'e:' || public.t_hash('T-0002'), 'accountSize', 1, 'isAccountPrimary', true, 'qflags', 0), 'hDerived', '891')))$$,
  (select v from ctx where k = 'runD')), 'CR422', null, 'SEC-09: nipStatus 77 is refused by import_derived');
select throws_ok(format($$select api.import_derived(%s, jsonb_build_array(jsonb_build_object('keyHash', public.t_hash('T-0002'),
  'derived', jsonb_build_object('nipStatus', 1, 'entityType', 1, 'accountKey', 'e:' || public.t_hash('T-0002'), 'accountSize', -5, 'isAccountPrimary', true, 'qflags', -1), 'hDerived', '892')))$$,
  (select v from ctx where k = 'runD')), 'CR422', null, 'SEC-09: negative accountSize / qflags are refused');
select throws_ok(format($$select api.import_derived(%s, (select jsonb_agg(x) from (select jsonb_build_object('keyHash', public.t_hash('T-0002'),
  'derived', jsonb_build_object('nipStatus', 1, 'entityType', 1, 'accountKey', 'e:' || public.t_hash('T-0002'), 'accountSize', 1, 'isAccountPrimary', true, 'qflags', 0), 'hDerived', '893') x
  from generate_series(1, 2)) y))$$, (select v from ctx where k = 'runD')), 'CR422', null, 'SEC-09: the same keyHash twice in import_derived is refused');
-- SEC-13: import_labels takes at most 2000 new dictionary values per call
select throws_ok(format($$select api.import_labels(%s, (select jsonb_agg(jsonb_build_object('facet', 'p.spec', 'val', 'sec13-' || g, 'label', 'x')) from generate_series(1, 2001) g))$$,
  (select v from ctx where k = 'runD')), 'CR413', null, 'SEC-13: more than 2000 new label values in one call: CR413');
select is(api.import_labels((select v::int from ctx where k = 'runD'), (select jsonb_agg(jsonb_build_object('facet', 'p.spec', 'val', 'sec13-' || g, 'label', 'x')) from generate_series(1, 2000) g)) ->> 'upserted',
  '2000', 'SEC-13: 2000 new label values are accepted');
select public.t_int($$select setval('crm.reg_dict_id_seq', 30000)::int$$);
select is(api.import_entries((select v::int from ctx where k = 'runD'), jsonb_build_array(public.t_row(9) || jsonb_build_object('facets',
  jsonb_build_object('p.spec', jsonb_build_array('sec07-ok'))))) ->> 'inserted', '1', 'a burned sequence is re-synchronised before new values are inserted');
select ok(public.t_int($$select max(id)::int from crm.reg_dict$$) < 5000, 'the new dictionary id continues after the real maximum, not after the burned values');
select is(api.db_usage() ->> 'dictLimit', '32767', 'db_usage reports the dictionary headroom');
select is(api.import_abort((select v::int from ctx where k = 'runD'), 'done') ->> 'status', 'aborted', 'cleanup');

-- a run left running for more than two hours is superseded by the next begin
select public.t_logout();
select public.t_int($$with r as (insert into crm.import_run (status, started_by, started_at) values ('running', 1, now() - interval '3 hours') returning id) select id from r$$) as stale_id \gset
select public.t_login('owner@example.test');
select lives_ok($$select public.t_begin()$$, 'a stale running run (older than 2 hours) does not block a new import');
select is(public.t_text($$select status from crm.import_run where id = (select max(id) from crm.import_run where error like 'superseded%')$$), 'failed', 'the stale run was marked failed');
select api.import_abort((select max(id) from (select (r ->> 'id')::int id from jsonb_array_elements(api.import_runs()) r where r ->> 'status' = 'running') x), 'cleanup');

-- history retention ------------------------------------------------------------------------------------------------------------------
select is(api.setting_set('history.keepRuns', '1') ->> 'ok', 'true', 'keep one run of history');
insert into ctx values ('runE', public.t_begin()::text);
select is(api.import_entries((select v::int from ctx where k = 'runE'), jsonb_build_array(public.t_row(2, p_tel => '221110002'))) ->> 'updated', '1', 'another refresh with a change');
select is(api.import_finish((select v::int from ctx where k = 'runE'), '{}') ->> 'status', 'applied', 'run E applied');
select is(public.t_int($$select count(distinct run_id)::int from crm.reg_change$$), 1, 'history older than the kept runs is pruned');
select is(jsonb_array_length(api.import_runs()) >= 5, true, 'import_runs lists the runs');

select * from finish();
rollback;
