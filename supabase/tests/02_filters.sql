-- Filter semantics, paging, facets, injection safety on the seeded synthetic register (db reset).
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
create function public.t_count(p_filter jsonb) returns int language sql as $$ select (api.leads_count(p_filter) ->> 'total')::int $$;

select public.t_login('owner@example.test');

select is(public.t_count('{}'), 300, 'all seeded entries in the register');
select is(public.t_count('{"kind":"p"}'), 120, 'kind p');
select is(public.t_count('{"kind":"r"}'), 180, 'kind r');

-- facets: OR within a facet, AND across facets; expectations come from the entry number in the book number
select is(public.t_count('{"kind":"p","sel":{"p.grp":["0"]}}'), 60, 'p.grp 0 (POZ-like group)');
select is(public.t_count('{"kind":"p","sel":{"p.grp":["0","1"]}}'), 120, 'OR inside one facet');
select is(public.t_count('{"kind":"p","sel":{"p.grp":["0"],"p.formType":["komercyjna"]}}'),
  public.t_int($$select count(*)::int from crm.reg_entry e where e.kind = 'p' and substr(e.ks, 3)::int % 2 = 0 and substr(e.ks, 3)::int % 5 in (0, 1, 4)$$), 'AND across two facets');
select is(public.t_count('{"kind":"p","sel":{"p.grp":["0"],"p.formType":["komercyjna"],"p.status":["aktywny"]}}'),
  public.t_int($$select count(*)::int from crm.reg_entry e where e.kind = 'p' and substr(e.ks, 3)::int % 2 = 0 and substr(e.ks, 3)::int % 5 in (0, 1, 4)$$), 'AND across three facets');
select is(public.t_count('{"kind":"p","sel":{"p.formType":["nie-ma-takiej"]}}'), 0, 'unknown facet value matches nothing');
-- system view definitions
select is(public.t_count('{"kind":"p","sel":{"p.status":["aktywny"],"p.rodzaje":["Ambulatoryjne świadczenia zdrowotne"],"p.grp":["0"]}}'), 60, 'POZ view filter');
select is(public.t_count('{"kind":"p","sel":{"p.status":["aktywny"],"p.formType":["komercyjna"]},"spec1Min":5}'),
  public.t_int($$select count(*)::int from crm.reg_entry e where e.kind = 'p' and substr(e.ks, 3)::int % 8 >= 5 and substr(e.ks, 3)::int % 5 in (0, 1, 4)$$), 'Centra view filter (spec1 >= 5 on commercial)');
-- kind all: a facet of one kind restricts only rows of that kind
select is(public.t_count('{"kind":"all","sel":{"p.grp":["0"]}}'), 60 + 180, 'kind all: p-facet does not hide practices');
select is(public.t_count('{"kind":"all","sel":{"p.grp":["0"],"r.src":["Rpz"]}}'), 60 + 45, 'kind all: p-facet and r-facet each restrict their own kind');
-- function tree
select is(public.t_count('{"kind":"p","sel":{"p.fn":["HC.1."]}}'), 120, 'p.fn prefix matches the subtree');
select is(public.t_count('{"kind":"p","sel":{"p.fn":["HC.1.3."]}}'), 40, 'p.fn deeper prefix');
select is(public.t_count('{"kind":"p","sel":{"p.fn":["HC.1.3.3.="]}}'), 40, 'p.fn trailing = matches the exact code');
select is(public.t_count('{"kind":"p","sel":{"p.fn":["HC.1.="]}}'), 0, 'p.fn exact code that has no entries');
-- numeric / date
select is(public.t_count('{"wpisRel":12}'), public.t_int($$select count(*)::int from crm.reg_entry where wpis >= date '2025-11-14'$$), 'wpisRel 12 counts from the report date');
select is(public.t_count('{"wpisOd":"2026-01-01","wpisDo":"2026-01-31"}'), public.t_int($$select count(*)::int from crm.reg_entry where wpis between date '2026-01-01' and date '2026-01-31'$$), 'date range works');
select ok(public.t_count('{"nkMin":10,"kind":"p"}') > 0 and public.t_count('{"nkMin":10,"kind":"p"}') < 120, 'nkMin');
-- contact flags
select is((api.leads_count('{"contact":{"email":true}}') ->> 'total')::int, (api.leads_count('{}') ->> 'email')::int, 'contact.email equals the e-mail count of everything');
select is(public.t_count('{"contact":{"email":true,"mobile":true,"kind":"p"}}'), public.t_count('{"contact":{"email":true,"mobile":true}}'), 'contact flags combine');
-- entity type and NIP status
select is(public.t_count('{"nipStatus":[3]}'), 2, 'two placeholder NIPs (a podmiot and a practice)');
select is(public.t_count('{"nipStatus":[4]}'), 1, 'one NIP with a bad checksum');
select is(public.t_count('{"entityType":[3]}'), 24, 'public entities (every 5th podmiot form)');
-- text search
select is(public.t_count('{"q":"PRZYCHODNIA TESTOWA 017"}'), 1, 'name search ignores case');
select is(public.t_count('{"q":"lodz"}'), 0, 'q searches name/NIP/e-mail/phone, not the city');
select is(public.t_count('{"miasto":"lodz"}'), public.t_int($$select count(*)::int from crm.reg_entry where miasto = 'Łódź'$$), 'city contains ignores diacritics and case');
select ok(public.t_count('{"miasto":"ŁÓDŹ"}') > 0, 'city lodz finds Łódź (upper case input)');
select is(public.t_count('{"q":"duplikat-klinika"}'), 2, 'e-mail contains');
select is(public.t_count('{"q":"600 000 008"}'), 0, 'phone search needs 9 digits in the registered format');
select is(public.t_count('{"q":"226000008"}'), 2, '9-digit phone matches shared number');
-- injection safety
select is(public.t_count('{"q":"x'' or 1=1 --"}'), 0, 'quote in q is harmless');
select is(public.t_count('{"kind":"p","sel":{"p.status":["a''); drop table crm.lead; --"]}}'), 0, 'quote in a facet value is harmless');
select is(public.t_count('{"sel":{"p.status":["a''); drop table crm.lead; --"]}}'), 180, 'kind all: an unmatched p-facet hides only podmioty');
select throws_ok($$select api.leads_count('{"sel":{"p.nope":["x"]}}')$$, 'CR422', null, 'unknown facet key: CR422');
select throws_ok($$select api.leads_count('{"kind":"x"}')$$, 'CR422', null, 'bad kind: CR422');
select throws_ok($$select api.leads_count('{"wpisOd":"not-a-date"}')$$, 'CR422', null, 'bad date: CR422');
select throws_ok($$select api.leads_count('{"entityType":["a"]}')$$, 'CR422', null, 'bad number: CR422');
-- paging and sorting
select throws_ok($$select api.leads_search('{}', null, 0, 201)$$, 'CR413', null, 'limit above 200: CR413');
select throws_ok($$select api.leads_search('{}', null, -1, 10)$$, 'CR422', null, 'negative offset: CR422');
select throws_ok($$select api.leads_search('{}', '{"key":"x","dir":"asc"}', 0, 10)$$, 'CR422', null, 'bad sort key: CR422');
select is((select count(distinct r ->> 'id')::int from (select jsonb_array_elements(api.leads_search('{}', null, 0, 100) -> 'rows') r
          union all select jsonb_array_elements(api.leads_search('{}', null, 100, 100) -> 'rows')) x), 200, 'two pages do not overlap');
select is(api.leads_search('{"kind":"p"}', '{"key":"name","dir":"asc"}', 0, 1) -> 'rows' -> 0 ->> 'name', 'Przychodnia Testowa 001', 'name ascending first row');
select is(api.leads_search('{"kind":"p"}', '{"key":"spec1","dir":"desc"}', 0, 1) -> 'rows' -> 0 ->> 'spec1', '7', 'spec1 descending first row');
select is(api.leads_search('{"kind":"p"}', '{"key":"wpis","dir":"desc"}', 0, 1) -> 'rows' -> 0 ->> 'name', 'Przychodnia Testowa 120 Sp. z o.o.', 'wpis descending');
-- facets: a facet's own selection is ignored in its counts, other filters apply
select is(api.leads_facets('{"kind":"p","sel":{"p.grp":["0"]}}', array['p.grp']) -> 'p.grp', '[["0",60],["1",60],["3",60]]'::jsonb, 'selected facet keeps counts of its other values');
select is(api.leads_facets('{"kind":"p","sel":{"p.grp":["0"]}}', array['p.formType']) -> 'p.formType' -> 0, '["komercyjna",36]'::jsonb, 'other facet counts honour the selection');
select ok(api.leads_facets('{"kind":"p"}', array['p.status','p.woj']) ? 'p.woj', 'several facets in one call');
-- dictionary
select ok(jsonb_array_length(api.dict(array['p.grp'])) = 3, 'dict returns the values of a facet');
select is(api.dict(array['p.grp']) -> 0 ->> 'label', 'Podstawowa opieka zdrowotna', 'dict carries labels');
-- CRM filters on a lead row
select public.t_login('anna@example.test');
select is(public.t_count('{"owner":["me"]}'), 1, 'owner me resolves to the caller');
select is(public.t_count('{"owner":["none"]}'), 298, 'owner none = unassigned');
select is(public.t_count('{"status":[2]}'), 1, 'status filter uses the lead row');
select is(public.t_count('{"status":[1]}'), 298, 'entries without a lead row count as the default status');
select is(public.t_count('{"nextStep":"today"}'), 1, 'next step today');
select is(public.t_count('{"nextStep":"due","owner":["me"],"dnc":"exclude"}'), 1, 'view "Do kontaktu dziś"');
select is(public.t_count('{"tags":[1]}'), 1, 'tag filter');
select is(public.t_count('{"lastContact":"never"}'), 299, 'last contact never');
select is(public.t_count('{"lastContact":"7d"}'), 1, 'last contact 7d');
select is(public.t_count('{"listId":1}'), 3, 'list filter');
select ok(public.t_count('{"validation":[1]}') > 0, 'derived validation: some entries need checking');
select is(public.t_count('{"validation":[0,1,2,3]}'), 300, 'validation filter covers all statuses');
select ok(public.t_count('{"openProposal":true}') > 0, 'open proposal filter');
select ok(public.t_count('{"accountPrimaryOnly":true}') < 300, 'accountPrimaryOnly reduces the result');

select * from finish();
rollback;
