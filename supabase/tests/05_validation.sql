-- Validation: NIP / e-mail / phone / WWW rules, entity types, account links and decisions, proposals, networks.
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
-- a 9-digit prefix whose weighted sum mod 11 is 10 (no check digit exists), found by search
create function public.t_nip_mod10() returns text language plpgsql security definer set search_path = '' as $$
declare g int; d text; s int; i int; w int[] := array[6,5,7,2,3,4,5,6,7];
begin
  for g in 100000000..100000999 loop
    d := g::text; s := 0;
    for i in 1..9 loop s := s + substr(d, i, 1)::int * w[i]; end loop;
    if s % 11 = 10 then return d || '0'; end if;
  end loop;
  return null;
end $$;

create function public.t_prop_rows(p_id int, p_extra text) returns jsonb language plpgsql as $$
declare p jsonb := api.val_proposal_get(p_id);
begin
  return jsonb_build_array(jsonb_build_object('kind', p ->> 'kind', 'matchValue', p ->> 'matchValue', 'confidence', 85, 'groupKey', 'gx',
    'members', case when p_extra is null then p -> 'members' else (p -> 'members') || to_jsonb(p_extra) end));
end $$;

-- NIP ----------------------------------------------------------------------------------------------------------------------
select is(private.nip_status('5260001246'), 1::smallint, 'valid NIP');
select is(private.nip_status(null), 0::smallint, 'null NIP: none');
select is(private.nip_status(''), 0::smallint, 'empty NIP: none');
select is(private.nip_status('123'), 2::smallint, 'too short: bad format');
select is(private.nip_status('12345678901'), 2::smallint, 'too long: bad format');
select is(private.nip_status('52600A1246'), 2::smallint, 'letters: bad format');
select is(private.nip_status('0000000000'), 3::smallint, 'zeros: placeholder');
select is(private.nip_status('1111111111'), 3::smallint, 'repeated digit: placeholder');
select is(private.nip_status('1234567890'), 4::smallint, 'wrong check digit');
select is(private.nip_status('5260001247'), 4::smallint, 'valid NIP with the last digit changed');
select is(private.nip_status(public.t_nip_mod10()), 4::smallint, 'weighted sum mod 11 = 10 is never valid');
select is(private.nip_status('0000000508'), 3::smallint, 'VAL-R3-9: a zero-padded NIP with a valid checksum is a placeholder');

-- e-mail -------------------------------------------------------------------------------------------------------------------
select is(private.normalize_email('  MAILTO:Jan.Kowalski@Przychodnia.PL '), 'jan.kowalski@przychodnia.pl', 'mailto prefix, case and spaces');
select is(private.normalize_email('<biuro@x.pl>'), 'biuro@x.pl', 'angle brackets stripped');
select is(private.normalize_email('   '), null, 'blank: null');
select ok(private.email_valid('a.b+c@sub.domain.pl'), 'plus tag and sub-domain are valid');
select ok(not private.email_valid('brak malpy'), 'no at sign');
select ok(not private.email_valid('a@b'), 'no dot in the domain');
select ok(not private.email_valid('a..b@x.pl'), 'consecutive dots');
select ok(not private.email_valid('a@x.p'), 'one-letter TLD');
select is(private.email_role('rejestracja@x.pl'), 'front', 'front desk mailbox');
select is(private.email_role('biuro+test@x.pl'), 'office', 'office mailbox, plus tag ignored');
select is(private.email_role('jan.kowalski@x.pl'), null, 'personal mailbox');
select is(private.domain_class('gmail.com'), 'free', 'free-mail domain');
select is(private.domain_class('gmial.com'), 'typo', 'typo domain');
select is(private.domain_class('sanepid.gov.pl'), 'generic', 'sub-domain of a generic domain');
select is(private.domain_class('przychodnia.pl'), null, 'company domain has no class');
-- VAL-R3-1 / VAL-R3-7: public suffixes never cover their sub-domains; listed ISPs are free with their sub-domains
select is(private.domain_class('alab.com.pl'), null, 'VAL-R3-1: a company under .com.pl is a company domain');
select is(private.domain_class('uczelnia-test.edu.pl'), null, 'VAL-R3-7: an organisation under .edu.pl is a company domain');
select is(private.domain_class('medikon.net.pl'), null, 'VAL-R3-7: a company under .net.pl is a company domain');
select is(private.domain_class('toya.net.pl'), 'free', 'VAL-R3-7: a listed ISP under .net.pl is free');
select is(private.domain_class('poczta.opoka.org.pl'), 'free', 'VAL-R3-7: a sub-domain of a listed portal is free');
select is(private.domain_class('nfz-rzeszow.pl'), 'generic', 'VAL-R3-7: an NFZ branch domain is generic');
select is(private.domain_class('02.pl'), 'typo', 'VAL-R3-4: 02.pl is a typo of o2.pl');
select public.t_int($$update crm.generic_domain set kind = 'generic', source = 'owner' where domain = 'com.pl' returning 1$$);
select is(private.domain_class('alab.com.pl'), null, 'VAL-R3-1: even an owner row for com.pl does not cover its sub-domains');
select is(private.domain_class('com.pl'), 'generic', 'VAL-R3-1: the owner row still matches the exact domain');
select public.t_int($$update crm.generic_domain set kind = 'typo', source = 'seed' where domain = 'com.pl' returning 1$$);
-- VAL-R4-3: bare public suffixes are typos, city / ISP portals free, medical universities generic, a path-identity portal social
select is(private.domain_class('com.pl'), 'typo', 'VAL-R4-3: x@com.pl is a typo');
select is(private.domain_class('waw.pl'), 'typo', 'VAL-R4-3: x@waw.pl is a typo');
select is(private.domain_class('alab.com.pl'), null, 'VAL-R4-3: the com.pl typo row does not cover companies under it');
select is(private.domain_class('poczta.net.pl'), 'typo', 'VAL-R4-3: poczta.net.pl is a typo');
select is(private.domain_class('elblag.com.pl'), 'free', 'VAL-R4-3: a city portal mailbox is free');
select is(private.domain_class('x.tenit.com.pl'), 'free', 'VAL-R4-3: a sub-domain of a listed ISP is free');
select is(private.domain_class('gumed.edu.pl'), 'generic', 'VAL-R4-3: a medical university is generic');
select is(private.domain_class('wydzial.ump.edu.pl'), 'generic', 'VAL-R4-3: a sub-domain of a medical university is generic');
select is(private.domain_class('medycyna.net.pl'), 'social', 'VAL-R4-3: a path-identity portal is social');
select is(private.email_quality('jan@przychodnia-test.pl', 1, false), 100::smallint, 'company address: 100');
select is(private.email_quality('jan@gmail.com', 1, false), 85::smallint, 'free mail: -15');
select is(private.email_quality('rejestracja@gmail.com', 3, true), 50::smallint, 'free + front desk + shared 2-5 + stale = 100-15-15-10-10');
select is(private.email_quality('biuro@x.pl', 8, false), 70::smallint, 'office -10, shared >= 6 -20');
select is(private.email_quality('jan@gmial.com', 1, false), 10::smallint, 'typo domain sets the score to 10');
select is(private.email_quality('zly', 1, false), 0::smallint, 'invalid: 0');
-- phone and WWW ---------------------------------------------------------------------------------------------------------------------
select is(private.phone_quality('kom', 1, false), 100::smallint, 'mobile 100');
select is(private.phone_quality('stac', 5, false), 50::smallint, 'landline shared by 5: -35');
select is(private.phone_quality('inny', 12, true), 0::smallint, 'other class, switchboard, stale: 60-50-10');
select is(private.phone_quality(null, 1, false), 0::smallint, 'unparseable: 0');
select is(private.normalize_www('HTTPS://www.Przychodnia-Test.pl:8080/kontakt?x=1#a'), 'przychodnia-test.pl', 'scheme, www, port, path, query, fragment');
select is(private.normalize_www('www2.example.pl.'), 'example.pl', 'www2 and trailing dot');
select is(private.normalize_www('brak'), null, 'junk: brak');
select is(private.normalize_www('-'), null, 'junk: dash');
select is(private.normalize_www('jan@x.pl'), null, 'e-mail in the WWW field');
select is(private.normalize_www('nie ma spacji'), null, 'whitespace');
select is(private.normalize_www('localhost'), null, 'no dot');
-- entity type ------------------------------------------------------------------------------------------------------------------------
select is(private.entity_type('p', 'spółka z ograniczoną odpowiedzialnością', 'komercyjna', null, 'Rpm'), 1::smallint, 'spółka');
select is(private.entity_type('p', 'Działalność gospodarcza prowadzona przez osobę fizyczną - bez celu', 'komercyjna', null, 'Rpm'), 2::smallint, 'JDG incl. the non-profit variant');
select is(private.entity_type('p', 'samodzielny publiczny zakład opieki zdrowotnej', 'publiczna', null, 'Rpm'), 3::smallint, 'public body');
select is(private.entity_type('p', null, null, null, 'Rpm'), 1::smallint, 'unknown form: company');
select is(private.entity_type('r', null, null, 'indywidualna', 'Rpz'), 4::smallint, 'individual practice');
select is(private.entity_type('r', null, null, 'grupowa', 'Rpz'), 5::smallint, 'group practice by type');
select is(private.entity_type('r', null, null, null, 'Rpzpg'), 5::smallint, 'group practice by source');

-- account links ----------------------------------------------------------------------------------------------------------------------
select public.t_login('anna@example.test');
select is((select count(*)::int from jsonb_array_elements(api.lead_get(public.t_entry('P-00005')) -> 'account')), 1, 'seed: podmiot 5 and practice 5 are one account');
select is(api.lead_get(public.t_entry('P-00005')) -> 'row' ->> 'accountSize', '2', 'account size 2');
select is((api.val_account_link(public.t_entry('R-000005'), 'detach', null, 'to nie ten sam podmiot') -> 0 ->> 'accountSize'), '1', 'detach: both sides are single accounts again');
select ok((api.lead_get(public.t_entry('R-000005')) -> 'row' ->> 'accountKey') like 'e:%', 'a detached entry gets an e: key');
select is(api.lead_get(public.t_entry('P-00005')) -> 'row' ->> 'accountSize', '1', 'the remaining side was recomputed');
select is((api.lead_get(public.t_entry('P-00005')) -> 'row' ->> 'accountKey') like 'n:%', true, 'the NIP side keeps its n: key');
select is(public.t_int($$select count(*)::int from crm.val_decision where action = 'detach'$$), 1, 'a detach decision is stored');
select is(public.t_int($$select count(*)::int from crm.activity where type = 'validation' and entry_id = (select id from crm.reg_entry where ks = 'R-000005')$$), 1, 'a validation activity is written on the entry');
select public.t_login('owner@example.test');
select is(jsonb_array_length(api.val_decisions() -> 'detach'), 1, 'the import worker receives the detach decision');
select is(api.val_decisions() -> 'params' ->> 'staleBefore', '2023-11-10', 'and the parameters');
select public.t_login('anna@example.test');
select is(api.lead_get(public.t_entry('R-000005')) -> 'row' ->> 'accountKey' like 'e:%', true, 'sanity');
select throws_ok(format($$select api.val_account_link(%s, 'attach', 'n:0000000000', null)$$, public.t_entry('R-000005')), 'CR404', null, 'attach to an unknown account: CR404');
select throws_ok(format($$select api.val_account_link(%s, 'attach', null, null)$$, public.t_entry('R-000005')), 'CR422', null, 'attach without a target: CR422');
select throws_ok(format($$select api.val_account_link(%s, 'merge', null, null)$$, public.t_entry('R-000005')), 'CR422', null, 'bad action: CR422');
select is((api.val_account_link(public.t_entry('R-000005'), 'attach', public.t_text($$select account_key from crm.reg_entry where ks = 'P-00005'$$), null) -> 0 ->> 'accountSize'), '2', 'attach back: size 2 again');
select is(public.t_int($$select count(*)::int from crm.val_decision$$), 1, 'a later decision replaces the earlier one for the same entry');
select is(public.t_text($$select action from crm.val_decision$$), 'attach', 'now an attach decision');
select ok(public.t_text($$select body from crm.activity where type = 'validation' and entry_id = (select id from crm.reg_entry where ks = 'R-000005') order by id desc limit 1$$) like '%zastąpiono wcześniejszą decyzję%', 'the replaced decision is kept in the timeline');
select is((select count(*)::int from jsonb_array_elements(api.lead_get(public.t_entry('P-00005')) -> 'account')), 1, 'account is one again');

-- timeline in account scope merges the entries of the account
select ok(exists (select 1 from jsonb_array_elements(api.lead_timeline(public.t_entry('P-00005'), 'account', null, 50)) i
                  where (i ->> 'entryId')::int = public.t_entry('R-000005') and i ->> 'type' = 'validation'), 'account timeline shows the practice''s validation activity');
select ok(not exists (select 1 from jsonb_array_elements(api.lead_timeline(public.t_entry('P-00005'), 'entry', null, 50)) i
                  where (i ->> 'entryId')::int = public.t_entry('R-000005')), 'entry timeline shows only its own entry');

-- primary entry rule ---------------------------------------------------------------------------------------------------------------
select is(api.lead_get(public.t_entry('P-00005')) -> 'row' ->> 'kind', 'p', 'sanity: podmiot');
select is(public.t_text($$select is_account_primary::text from crm.reg_entry where ks = 'P-00005'$$), 'true', 'podmiot is the account primary');
select is(public.t_text($$select is_account_primary::text from crm.reg_entry where ks = 'R-000005'$$), 'false', 'practice is not');

-- proposals --------------------------------------------------------------------------------------------------------------------------
select ok((api.val_summary(null) -> 'queues' -> 'networks' ->> 'open')::int > 0, 'summary: open network proposals');
select ok((api.val_summary(null) -> 'queues' -> 'accounts' ->> 'open')::int > 0, 'summary: open account proposals');
select ok((api.val_summary(null) -> 'records' ->> 'doSprawdzenia')::int > 0, 'summary: records to check');
select is((api.val_summary(null) -> 'records' ->> 'niezweryfikowany')::int + (api.val_summary(null) -> 'records' ->> 'doSprawdzenia')::int
          + (api.val_summary(null) -> 'records' ->> 'zweryfikowany')::int + (api.val_summary(null) -> 'records' ->> 'odrzucony')::int,
          300, 'record counts cover all entries');
select ok((api.val_summary('{"kind":"r"}') -> 'queues' -> 'networks' ->> 'open')::int <= (api.val_summary(null) -> 'queues' -> 'networks' ->> 'open')::int, 'a filter restricts the counts');
select is(api.val_queue('networks', 0::smallint, null, 0, 50) -> 0 ->> 'confidence', (select max(c)::text from (select (p ->> 'confidence')::int c from jsonb_array_elements(api.val_queue('networks', 0::smallint, null, 0, 50)) p) x), 'queue is sorted by confidence');
select throws_ok($$select api.val_queue('records', null, null, 0, 10)$$, 'CR422', null, 'the records queue is not a proposal queue: CR422');
select throws_ok($$select api.val_queue('networks', null, null, 0, 201)$$, 'CR413', null, 'queue limit above 200: CR413');
select is(jsonb_array_length(api.val_proposal_get((api.val_queue('networks', 0::smallint, null, 0, 1) -> 0 ->> 'id')::int) -> 'entries') >= 2, true, 'proposal detail lists the member entries');
select throws_ok($$select api.val_proposal_get(999999)$$, 'CR404', null, 'unknown proposal: CR404');

create temp table ctx (k text primary key, v text);
grant all on ctx to public;
insert into ctx select 'email', (p ->> 'id') from jsonb_array_elements(api.val_queue('networks', 0::smallint, null, 0, 200)) p where p ->> 'kind' = 'email' limit 1;
select is((api.val_decide((select v::int from ctx where k = 'email'), '{"decision":"accept","newNetworkName":"Sieć testowa","note":"ta sama firma"}') ->> 'status')::int, 1, 'accept: proposal decided');
select is(api.networks_list() -> 0 ->> 'name', 'Sieć testowa', 'network created');
select is(api.networks_list() -> 0 ->> 'accounts', '2', 'both accounts are members');
select is((api.lead_get(public.t_entry('P-00004')) -> 'network' ->> 'name'), 'Sieć testowa', 'the card shows the network');
select is(public.t_int($$select count(*)::int from crm.activity where type = 'validation' and body like 'Sieć: Sieć testowa%'$$), 2, 'one activity per member');
select throws_ok(format($$select api.val_decide(%s, '{"decision":"accept","memberKeys":["n:zzz"]}')$$, (select v from ctx where k = 'email')), 'CR422', null, 'memberKeys must belong to the proposal');
select throws_ok(format($$select api.val_decide(%s, '{"decision":"explode"}')$$, (select v from ctx where k = 'email')), 'CR422', null, 'bad decision: CR422');
select is((api.val_decide((select v::int from ctx where k = 'email'), '{"decision":"reopen"}') ->> 'status')::int, 0, 'reopen');
select is((api.network_member_remove((api.networks_list() -> 0 ->> 'id')::int, (select (api.val_proposal_get((select v::int from ctx where k = 'email')) -> 'members' ->> 0))) ->> 'removed'), 'true', 'a member leaves the network');
select throws_ok($$select api.network_member_remove(1, 'n:nope')$$, 'CR404', null, 'removing a non-member: CR404');
select is(api.network_upsert('{"name":"Druga sieć"}') ->> 'accounts', '0', 'network created empty');
select throws_ok($$select api.network_upsert('{"name":"druga SIEĆ"}')$$, 'CR409', null, 'duplicate network name: CR409');

-- reject on an account_check proposal detaches the minority group (ties: the practices)
insert into ctx select 'acc', (p ->> 'id') from jsonb_array_elements(api.val_queue('accounts', 0::smallint, null, 0, 200)) p
  where p -> 'members' ->> 0 = public.t_text($$select account_key from crm.reg_entry where ks = 'P-00010'$$) limit 1;
select is((api.val_decide((select v::int from ctx where k = 'acc'), '{"decision":"reject","note":"różne podmioty"}') ->> 'status')::int, 2, 'reject: proposal rejected');
select is(api.lead_get(public.t_entry('P-00010')) -> 'row' ->> 'accountSize', '1', 'rejecting an account check split the account');
select ok((api.lead_get(public.t_entry('R-000010')) -> 'row' ->> 'accountKey') like 'e:%', 'the practice (minority on a tie) was detached');

-- min confidence hides proposals; decided proposals reopen only for new members
select public.t_login('owner@example.test');
select is(api.setting_set('val.minConfidence', '99') ->> 'ok', 'true', 'raise the minimum confidence');
select is(jsonb_array_length(api.val_queue('networks', null, null, 0, 50)), 0, 'proposals below the minimum are hidden');
select is(api.setting_set('val.minConfidence', '50') ->> 'ok', 'true', 'restore');

-- CONTRACT 6.6: a decided proposal reopens only when members appear that were not seen at decision time
select public.t_login('owner@example.test');
select is((api.val_decide((select v::int from ctx where k = 'email'), '{"decision":"accept","newNetworkName":"Sieć testowa 2"}') ->> 'status')::int, 1, 'accept the e-mail proposal again');
insert into ctx values ('run', (api.import_begin('{"fileName":"t","fileSha256":"x","indexVersion":2,"createdAt":null,"today":"2026-12-01","reportDate":"2026-11-30","sources":[],"hashVersion":1,"preview":{}}') ->> 'runId'));
select is(api.import_proposals((select v::int from ctx where k = 'run'), public.t_prop_rows((select v::int from ctx where k = 'email'), null), false) ->> 'reopened', '0', 'same members: the decision stands');
select is((api.val_proposal_get((select v::int from ctx where k = 'email')) ->> 'status')::int, 1, 'still accepted');
select is(api.import_proposals((select v::int from ctx where k = 'run'), public.t_prop_rows((select v::int from ctx where k = 'email'), 'e:0000000000000000'), false) ->> 'reopened', '1', 'a new member reopens it');
select is((api.val_proposal_get((select v::int from ctx where k = 'email')) ->> 'status')::int, 0, 'status back to open');
select is(api.val_proposal_get((select v::int from ctx where k = 'email')) -> 'newMembers', '["e:0000000000000000"]'::jsonb, 'the new member is listed');
select ok(api.val_proposal_get((select v::int from ctx where k = 'email')) ->> 'decidedBy' is not null, 'the previous decision stays visible');
select is(api.import_abort((select v::int from ctx where k = 'run'), 'test') ->> 'status', 'aborted', 'cleanup');

select public.t_logout();
-- VAL-R2-1: a "person" proposal that contains a group practice cannot be accepted (no merge into the group's account)
create function public.t_grp_person() returns int language plpgsql security definer set search_path = '' as $$
declare v_grp text; v_other text; v_id int;
begin
  select account_key into v_grp from crm.reg_entry where entity_type = 5 limit 1;
  select account_key into v_other from crm.reg_entry where entity_type = 4 and account_key <> coalesce(v_grp, '') limit 1;
  if v_grp is null or v_other is null then return null; end if;
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members) values ('person', 'npwz:lek:test-r2-1', 90, 'test-r2-1', array[v_grp, v_other])
    returning id into v_id;
  return v_id;
end $$;
-- VAL-R2-2: open "partner" proposals do not make an entry "do sprawdzenia"
create function public.t_partner_open() returns int language plpgsql security definer set search_path = '' as $$
declare v_k text; v_n int;
begin
  select account_key into v_k from crm.reg_entry order by id limit 1;
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members) values ('partner', 'test-r2-2', 75, 'test-r2-2', array[v_k, 'n:0000000001']);
  select count(*) into v_n from crm.v_open_member where account_key = v_k and not exists
    (select 1 from crm.val_proposal p where p.status = 0 and p.kind <> 'partner' and v_k = any (p.members));
  return v_n;
end $$;
select public.t_login('owner@example.test');
insert into ctx values ('grpperson', coalesce(public.t_grp_person()::text, ''));
select is((select v from ctx where k = 'grpperson') <> '', true, 'seed has a group practice and an individual practice account');
select throws_ok(format($$select api.val_decide(%s, '{"decision":"accept"}')$$, (select v from ctx where k = 'grpperson')), 'CR422', null,
  'accepting a "person" proposal with a group practice is refused');

select is(public.t_partner_open(), 0, 'a partner proposal alone adds no account to v_open_member');

-- VAL-R3-2 / VAL-R3-3: accepting a "person" proposal moves only that person's practices, into the valid-NIP account, and is
-- refused while a member account mixes a public body with practices. Synthetic entries of the seed are re-keyed here.
select public.t_logout();
create function public.t_set_npwz(p_id int, p_npwz text) returns void language plpgsql security definer set search_path = '' as $$
begin
  update crm.reg_detail_block set recs = jsonb_set(recs::jsonb, array[p_id::text, 'd', 'npwz'], to_jsonb(p_npwz))::text
  where block_no = (p_id >> 5);
end $$;
create function public.t_person_case(p_case text) returns int language plpgsql security definer set search_path = '' as $$
declare v_h int; v_j int; v_d1 int; v_d2 int; v_id int;
begin
  select id into v_h from crm.reg_entry where entity_type = 3 order by id limit 1;
  select id into v_j from crm.reg_entry where entity_type in (1, 2) and kind = 'p' order by id limit 1;
  select id into v_d1 from crm.reg_entry where entity_type = 4 and src = 1 order by id limit 1;
  select id into v_d2 from crm.reg_entry where entity_type = 4 and src = 1 and id <> v_d1 order by id limit 1;
  update crm.reg_entry set entity_type = 2, qflags = 0 where id = v_j;
  update crm.reg_entry set qflags = 0 where id in (v_h, v_d1, v_d2);
  perform public.t_set_npwz(v_d1, '7777777');
  perform public.t_set_npwz(v_d2, '7777777');
  if p_case = 'mixed' then
    -- H (public body) and D1 on one NIP, D2 on the doctor's own NIP
    update crm.reg_entry set account_key = 'n:9999999999' where id in (v_h, v_d1);
    update crm.reg_entry set account_key = 'n:1111111111' where id = v_d2;
    insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
    values ('person', 'npwz:lek:7777777', 90, 'r3-mixed', array['n:1111111111', 'n:9999999999']) returning id into v_id;
  else
    -- D1 with the doctor's own JDG on a valid NIP, D2 alone on an e: account (missing NIP); one person (VAL-R4-1 names)
    update crm.reg_entry set name = 'Gabinet Lekarski Jan Testowy' where id = v_j;
    update crm.reg_entry set name = 'Jan Testowy' where id in (v_d1, v_d2);
    update crm.reg_entry set account_key = 'n:5260001246' where id in (v_j, v_d1);
    update crm.reg_entry set account_key = 'e:' || private.hex16(key_hash) where id = v_d2;
    insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
    values ('person', 'npwz:lek:7777777', 90, 'r3-clean', array[(select account_key from crm.reg_entry where id = v_d2), 'n:5260001246']) returning id into v_id;
  end if;
  return v_id;
end $$;
insert into ctx values ('pmixed', public.t_person_case('mixed')::text);
select public.t_login('owner@example.test');
select throws_ok(format($$select api.val_decide(%s, '{"decision":"accept"}')$$, (select v from ctx where k = 'pmixed')), 'CR422', 'account_check_first',
  'VAL-R3-2: a person proposal whose member account mixes a public body with practices is refused');
select is(public.t_int($$select count(*)::int from crm.reg_entry where account_key = 'n:1111111111'$$), 1, 'VAL-R3-2: nothing moved after the refusal');
select public.t_logout();
delete from crm.val_proposal where id = (select v::int from ctx where k = 'pmixed');
insert into ctx values ('pclean', public.t_person_case('clean')::text);
select public.t_login('owner@example.test');
select is((api.val_decide((select v::int from ctx where k = 'pclean'), '{"decision":"accept"}') ->> 'status')::int, 1, 'VAL-R3-2: a clean person proposal is accepted');
select is(public.t_int($$select count(*)::int from crm.reg_entry where account_key = 'n:5260001246'$$), 3,
  'VAL-R3-3: the practice with the missing NIP joined the valid-NIP account (JDG + both practices)');
select is(public.t_int($$select count(*)::int from crm.reg_entry where account_key like 'e:%' and id in
  (select id from crm.reg_entry where entity_type = 4 and src = 1 order by id limit 2)$$), 0, 'VAL-R3-3: no entry was moved into the e: account');
select is(public.t_int($$select count(*)::int from crm.reg_entry where account_key = 'n:5260001246' and entity_type = 2$$), 1,
  'VAL-R3-2: the JDG stays in its own account (only the practices of the person move)');


-- VAL-R4-1 / VAL-R4-2 / VAL-R4-4: the person target must hold the licence and belong to that person; "split first, then accept"
-- works; rejecting the account check of a JDG account detaches only the other person's practice.
select public.t_logout();
select is(public.t_text($$select private.same_person('Usługi Radiologiczne Ewa Testowa', 'Grażyna Przykładowa')::text$$), 'false', 'VAL-R4-1: a different person');
select is(public.t_text($$select private.same_person('Iga Paulina Testowa-Przykładowa', 'Iga Testowa - Przykładowa')::text$$), 'true', 'VAL-R4-1: middle name and hyphen');
select is(public.t_text($$select private.same_person('Fizjoterapia Testowy', 'Jan Testowy')::text$$), 'false', 'VAL-R5-2: a shared surname alone is not the same person');
select is(public.t_text($$select private.same_person('Robert Test', 'Urszula Test')::text$$), 'false', 'VAL-R5-2: family members with one surname are two people');
select is(public.t_text($$select private.same_person('R. Test', 'U. Test')::text$$), 'false', 'VAL-R5-2: different first initials');
select is(public.t_text($$select private.same_person('Osoba fizyczna: Ewa Testowa Próbna', 'Ewa Zofia Przykładowa')::text$$), 'true', 'VAL-R5-1: the same first name (a changed surname)');
select is(public.t_text($$select private.same_person('Fizjoterapia Anna Testowa', 'Anna Maria Przykładowa')::text$$), 'true', 'VAL-R5-1: the JDG owner''s first name, another surname');
select is(public.t_text($$select private.same_person('Łucja Śliwińska', 'Ł. Sliwinska')::text$$), 'true', 'diacritics folded, initials');
select is(private.name_tokens('Tešťák Přykładová-Çestowa'), array['testak', 'prykladova', 'cestowa'], 'VAL-R5-5: Latin Extended letters are folded, not split');
select is(public.t_text($$select private.same_person('Ola Teśťová', 'Ola Testova')::text$$), 'true', 'VAL-R5-5: č š ř … fold like the worker');
select is(private.licence(' 0000000 '), null, 'a placeholder licence identifies nobody');
select is(private.licence(' 1234567 '), '1234567', 'a licence is trimmed');
create function public.t_r4_setup() returns void language plpgsql security definer set search_path = '' as $$
declare v_h int; v_x int; v_x2 int; d int[]; v_id int;
begin
  select id into v_h from crm.reg_entry where entity_type = 3 order by id offset 5 limit 1;
  select id into v_x from crm.reg_entry where entity_type in (1, 2) and kind = 'p' order by id offset 5 limit 1;
  select id into v_x2 from crm.reg_entry where entity_type in (1, 2) and kind = 'p' order by id offset 6 limit 1;
  select array_agg(id order by id) into d from (select id from crm.reg_entry where entity_type = 4 and src = 1 order by id offset 10 limit 7) q;
  update crm.reg_entry set qflags = 0 where id in (v_h, v_x, v_x2) or id = any (d);
  -- VAL-R4-1: JDG of X plus Y's practice on X's NIP (the bigger account, no ACCOUNT_CHECK bit); Y's own practice on Y's NIP
  update crm.reg_entry set entity_type = 2, name = 'Usługi Radiologiczne Ewa Testowa', account_key = 'n:1000000013' where id = v_x;
  update crm.reg_entry set name = 'Grażyna Przykładowa', account_key = 'n:1000000013' where id = d[1];
  update crm.reg_entry set name = 'Grażyna Przykładowa', account_key = 'n:1000000024' where id = d[2];
  perform public.t_set_npwz(d[1], '3344556');
  perform public.t_set_npwz(d[2], '3344556');
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
  values ('person', 'npwz:lek:3344556', 90, 'r4-1', array['n:1000000013', 'n:1000000024']) returning id into v_id;
  insert into ctx values ('r4p1', v_id::text), ('r4y1', d[1]::text), ('r4x', v_x::text);
  -- VAL-R4-2: public body H and D1 on n:…35, both with the import's ACCOUNT_CHECK bit; D2 on the doctor's own NIP
  update crm.reg_entry set account_key = 'n:1000000035', qflags = 524288 where id in (v_h, d[3]);
  update crm.reg_entry set name = 'Ola Przykładowa' where id in (d[3], d[4]);
  update crm.reg_entry set account_key = 'n:1000000046' where id = d[4];
  perform public.t_set_npwz(d[3], '3344557');
  perform public.t_set_npwz(d[4], '3344557');
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
  values ('account_check', 'n:1000000035', 60, 'r4-2a', array['n:1000000035']) returning id into v_id;
  insert into ctx values ('r4a2', v_id::text), ('r4d1', d[3]::text), ('r4h', v_h::text);
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
  values ('person', 'npwz:lek:3344557', 55, 'r4-2p', array['n:1000000035', 'n:1000000046']) returning id into v_id;
  insert into ctx values ('r4p2', v_id::text);
  -- VAL-R4-4: an 'osoba fizyczna' JDG with its owner's practice and another person's practice under one NIP
  update crm.reg_entry set entity_type = 2, name = 'Osoba fizyczna: Ewa Testowa Próbna', account_key = 'n:1000000057' where id = v_x2;
  update crm.reg_entry set name = 'Ewa Testowa', account_key = 'n:1000000057' where id = d[5];
  update crm.reg_entry set name = 'Zofia Przykładowa', account_key = 'n:1000000057' where id = d[6];
  perform public.t_set_npwz(d[5], '5550001');
  perform public.t_set_npwz(d[6], '5550002');
  perform private.recompute_accounts(array['n:1000000013', 'n:1000000024', 'n:1000000035', 'n:1000000046', 'n:1000000057']);
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
  values ('account_check', 'n:1000000057', 60, 'r4-4a', array['n:1000000057']) returning id into v_id;
  insert into ctx values ('r4a4', v_id::text), ('r4own', d[5]::text), ('r4other', d[6]::text);
end $$;
select public.t_r4_setup();
select public.t_login('owner@example.test');
select is((api.val_decide((select v::int from ctx where k = 'r4p1'), '{"decision":"accept"}') ->> 'status')::int, 1, 'VAL-R4-1: the person proposal is accepted');
select is(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r4y1'))), 'n:1000000024',
  'VAL-R4-1: Y''s practice moved into Y''s own account, not into the bigger account with X''s JDG');
select is(public.t_int($$select count(*)::int from crm.reg_entry where account_key = 'n:1000000013'$$), 1, 'VAL-R4-1: X''s JDG stays alone');

select throws_ok(format($$select api.val_decide(%s, '{"decision":"accept"}')$$, (select v from ctx where k = 'r4p2')), 'CR422', 'account_check_first',
  'VAL-R4-2: before the split the person accept is refused');
select is((api.val_decide((select v::int from ctx where k = 'r4a2'), '{"decision":"reject"}') ->> 'status')::int, 2, 'VAL-R4-2: the account check is rejected (split)');
select ok(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r4d1'))) like 'e:%',
  'VAL-R4-2: the practice was detached from the public body');
select ok((api.val_proposal_get((select v::int from ctx where k = 'r4p2')) -> 'members')
          ? public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r4d1'))),
  'VAL-R4-2: the open person proposal follows the detached practice');
select is((api.val_decide((select v::int from ctx where k = 'r4p2'), '{"decision":"accept"}') ->> 'status')::int, 1,
  'VAL-R4-2: after the split the person proposal is accepted (the stale ACCOUNT_CHECK bit no longer refuses)');
select is(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r4d1'))), 'n:1000000046',
  'VAL-R4-2: the practice joined the account that holds the licence');
select is(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r4h'))), 'n:1000000035',
  'VAL-R4-2: the public body was not touched');
select is(public.t_int($$select count(*)::int from crm.reg_entry where account_key = 'n:1000000035'$$), 1, 'VAL-R4-2: nothing moved into the public body''s account');

select is((api.val_decide((select v::int from ctx where k = 'r4a4'), '{"decision":"reject"}') ->> 'status')::int, 2, 'VAL-R4-4: the JDG account check is rejected');
select ok(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r4other'))) like 'e:%',
  'VAL-R4-4: the other person''s practice was detached');
select is(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r4own'))), 'n:1000000057',
  'VAL-R4-4: the JDG owner''s own practice stays with the JDG');
select public.t_logout();

-- Round 3. RD2-1: the person is NOT the primary entry of the account being split; after the split the old account keeps only
-- another doctor's practice and must no longer refuse the person accept. VAL-R5-1: a JDG with the owner's practice under a
-- changed surname is one person (reject detaches nothing, and the card is told so). VAL-R5-2: two practices of one family
-- (shared surname, different first names) are split. Fresh synthetic entries of the seed are re-keyed.
create function public.t_r5_setup() returns void language plpgsql security definer set search_path = '' as $$
declare v_x int; d int[]; n3 int[]; v_id int;
begin
  select id into v_x from crm.reg_entry where entity_type in (1, 2) and kind = 'p' order by id offset 8 limit 1;
  select array_agg(id order by id) into d from (select id from crm.reg_entry where entity_type = 4 and src = 1 order by id offset 20 limit 9) q;
  select array_agg(id order by id) into n3 from (select id from crm.reg_entry where entity_type = 4 and src = 3 order by id offset 20 limit 2) q;
  update crm.reg_entry set qflags = 0 where id = v_x or id = any (d) or id = any (n3);
  -- RD2-1: another doctor (primary) and the person on n:…68; the person's own practice on n:…79
  update crm.reg_entry set name = 'Olga Inna', account_key = 'n:1000000068' where id = d[1];
  update crm.reg_entry set name = 'Piotr Testowy', account_key = 'n:1000000068' where id = d[2];
  update crm.reg_entry set name = 'Piotr Testowy', account_key = 'n:1000000079' where id = d[3];
  perform public.t_set_npwz(d[1], '6000001');
  perform public.t_set_npwz(d[2], '6000002');
  perform public.t_set_npwz(d[3], '6000002');
  -- VAL-R5-1: a JDG and its owner's practice under another surname
  update crm.reg_entry set entity_type = 2, name = 'Fizjoterapia Anna Testowa', account_key = 'n:1000000080' where id = v_x;
  update crm.reg_entry set name = 'Anna Maria Przykładowa', account_key = 'n:1000000080' where id = d[4];
  -- VAL-R5-2: practices of two professions on one NIP: 'Robert Test' (primary) with 'Urszula Test' and 'Robert Adam Test'
  update crm.reg_entry set name = 'Robert Test', account_key = 'n:1000000091' where id = d[5];
  update crm.reg_entry set name = 'Urszula Test', account_key = 'n:1000000091' where id = n3[1];
  update crm.reg_entry set name = 'Robert Adam Test', account_key = 'n:1000000091' where id = n3[2];
  -- RD2-2: one name with two numbers of one register (a doctor's and a dentist's) on n:…02, the first number again on n:…13
  update crm.reg_entry set name = 'Olga Testowa', account_key = 'n:1000000102' where id in (d[6], d[7]);
  update crm.reg_entry set name = 'Olga Testowa', account_key = 'n:1000000113' where id = d[8];
  perform public.t_set_npwz(d[6], '6100001');
  perform public.t_set_npwz(d[7], '6100002');
  perform public.t_set_npwz(d[8], '6100001');
  perform private.recompute_accounts(array['n:1000000068', 'n:1000000079', 'n:1000000080', 'n:1000000091', 'n:1000000102', 'n:1000000113']);
  update crm.reg_entry set is_account_primary = (id = d[1]) where account_key = 'n:1000000068';
  update crm.reg_entry set is_account_primary = (id = d[5]) where account_key = 'n:1000000091';
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
  values ('account_check', 'n:1000000068', 60, 'r5-1a', array['n:1000000068']) returning id into v_id;
  insert into ctx values ('r5a1', v_id::text), ('r5person', d[2]::text), ('r5other', d[1]::text);
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
  values ('person', 'npwz:lek:6000002', 55, 'r5-1p', array['n:1000000068', 'n:1000000079']) returning id into v_id;
  insert into ctx values ('r5p1', v_id::text);
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
  values ('account_check', 'n:1000000080', 60, 'r5-jdg', array['n:1000000080']) returning id into v_id;
  insert into ctx values ('r5jdg', v_id::text), ('r5jdgprac', d[4]::text);
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
  values ('account_check', 'n:1000000091', 60, 'r5-fam', array['n:1000000091']) returning id into v_id;
  insert into ctx values ('r5fam', v_id::text), ('r5urszula', n3[1]::text), ('r5robert2', n3[2]::text);
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
  values ('person', 'npwz:lek:6100001', 90, 'r5-two', array['n:1000000102', 'n:1000000113']) returning id into v_id;
  insert into ctx values ('r5two', v_id::text), ('r5two8', d[8]::text);
end $$;
select public.t_r5_setup();
select public.t_login('owner@example.test');
select throws_ok(format($$select api.val_decide(%s, '{"decision":"accept"}')$$, (select v from ctx where k = 'r5p1')), 'CR422', 'account_check_first',
  'RD2-1: before the split the person accept is refused (another doctor''s licence in the account)');
select is(api.val_proposal_get((select v::int from ctx where k = 'r5a1')) -> 'detachIds', jsonb_build_array((select v::int from ctx where k = 'r5person')),
  'VAL-R5-1: the card is told which entry a reject detaches (the non-primary person with another licence)');
select is((api.val_decide((select v::int from ctx where k = 'r5a1'), '{"decision":"reject"}') ->> 'status')::int, 2, 'RD2-1: the account check is rejected');
select ok(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r5person'))) like 'e:%',
  'RD2-1: the person''s practice (not the primary) was detached');
select is(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r5other'))), 'n:1000000068',
  'RD2-1: the other doctor stays in the old account');
select is((api.val_decide((select v::int from ctx where k = 'r5p1'), '{"decision":"accept"}') ->> 'status')::int, 1,
  'RD2-1: after the split the person accept succeeds although the old account (still a member) holds another licence');
select is(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r5person'))), 'n:1000000079',
  'RD2-1: the person''s practice joined the person''s own account');
select is(public.t_int($$select count(*)::int from crm.reg_entry where account_key = 'n:1000000068'$$), 1, 'RD2-1: the old account keeps only the other doctor');

select is(api.val_proposal_get((select v::int from ctx where k = 'r5jdg')) -> 'detachIds', '[]'::jsonb,
  'VAL-R5-1: a JDG with its owner''s practice under another surname: a reject would detach nothing');
select is(api.val_proposal_get((select v::int from ctx where k = 'r5fam')) -> 'detachIds', jsonb_build_array((select v::int from ctx where k = 'r5urszula')),
  'VAL-R5-2: only Urszula Test would be detached (Robert Adam Test nests with the primary)');
select is((api.val_decide((select v::int from ctx where k = 'r5fam'), '{"decision":"reject"}') ->> 'status')::int, 2, 'VAL-R5-2: the family account check is rejected');
select ok(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r5urszula'))) like 'e:%',
  'VAL-R5-2: the other family member''s practice was detached');
select is(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r5robert2'))), 'n:1000000091',
  'VAL-R5-2: the primary''s own practice of another profession stays');
select ok(not (api.val_proposal_get((select v::int from ctx where k = 'r5fam')) ? 'detachIds'), 'detachIds only for open account checks');
select is(public.t_text($$select private.minority_entries('n:1000000102')::text$$), '{}', 'RD2-2: one name with two numbers of one register is one person (nothing to split)');
select is((api.val_decide((select v::int from ctx where k = 'r5two'), '{"decision":"accept"}') ->> 'status')::int, 1,
  'RD2-2: a person accept is not refused for the same person''s second number of the register (no "split first" dead end)');
select is(public.t_int($$select count(*)::int from crm.reg_entry where account_key in ('n:1000000102', 'n:1000000113')$$), 3, 'RD2-2: all three practices are still in the two accounts');
select public.t_logout();

-- VAL-R6-1: two individual practices of one profession with different valid licence numbers share a first name only. The
-- first-name rule must not make them one person: nothing is spared by it in minority_entries, the person accept is refused
-- until the account is split, and a JDG against a practice keeps the first-name rule.
create function public.t_r6_setup() returns void language plpgsql security definer set search_path = '' as $$
declare d int[]; v_id int;
begin
  select array_agg(id order by id) into d from (select id from crm.reg_entry where entity_type = 4 and src = 1 order by id offset 40 limit 3) q;
  update crm.reg_entry set qflags = 0 where id = any (d);
  update crm.reg_entry set name = 'Anna Testowa', account_key = 'n:1000000121' where id = d[1];
  update crm.reg_entry set name = 'Anna Próbna', account_key = 'n:1000000121' where id = d[2];
  update crm.reg_entry set name = 'Anna Próbna', account_key = 'n:1000000122' where id = d[3];
  perform public.t_set_npwz(d[1], '7000021');
  perform public.t_set_npwz(d[2], '7000022');
  perform public.t_set_npwz(d[3], '7000022');
  perform private.recompute_accounts(array['n:1000000121', 'n:1000000122']);
  update crm.reg_entry set is_account_primary = (id = d[1]) where account_key = 'n:1000000121';
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
  values ('account_check', 'n:1000000121', 60, 'r6-ac', array['n:1000000121']) returning id into v_id;
  insert into ctx values ('r6ac', v_id::text), ('r6second', d[2]::text);
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members)
  values ('person', 'npwz:lek:7000022', 90, 'r6-p', array['n:1000000121', 'n:1000000122']) returning id into v_id;
  insert into ctx values ('r6p', v_id::text), ('r6own', d[3]::text);
end $$;
select public.t_r6_setup();
select public.t_login('owner@example.test');
select is(public.t_text($$select private.same_person('Anna Testowa', 'Anna Próbna')::text$$), 'true', 'VAL-R6-1: by default a shared first name is one person (JDG against practice, changed surname)');
select is(public.t_text($$select private.same_person('Anna Testowa', 'Anna Próbna', true)::text$$), 'false', 'VAL-R6-1: nest-only does not match a shared first name');
select is(public.t_text($$select private.same_person('Anna Testowa', 'Anna Maria Testowa', true)::text$$), 'true', 'VAL-R6-1: nest-only still matches a name that nests');
select is(public.t_text($$select private.minority_entries('n:1000000121')::text$$), '{' || (select v from ctx where k = 'r6second') || '}',
  'VAL-R6-1: the second practice (another licence, same first name) is split out of the account');
select is(api.val_proposal_get((select v::int from ctx where k = 'r6ac')) -> 'detachIds', jsonb_build_array((select v::int from ctx where k = 'r6second')),
  'VAL-R6-1: the account check card is told which practice a reject detaches');
select throws_ok(format($$select api.val_decide(%s, '{"decision":"accept"}')$$, (select v from ctx where k = 'r6p')), 'CR422', 'account_check_first',
  'VAL-R6-1: the person accept is refused until the account is split (it would move her own-NIP practice into the other Anna''s account)');
select is((api.val_decide((select v::int from ctx where k = 'r6ac'), '{"decision":"reject"}') ->> 'status')::int, 2, 'VAL-R6-1: the account check is rejected (split)');
select is(public.t_text(format($$select account_key from crm.reg_entry where id = %s$$, (select v from ctx where k = 'r6own'))), 'n:1000000122',
  'VAL-R6-1: her own-NIP practice was not touched');
select is(public.t_int($$select count(*)::int from jsonb_array_elements(api.val_decisions() -> 'decidedProposals') d where d ->> 'kind' = 'account_check' and d ->> 'matchValue' = 'n:1000000121'$$), 1,
  'RD3-2: the import worker receives decided proposals (kind, matchValue, members) so the preview counts only those that stay open');
select is(public.t_int($$select count(*)::int from jsonb_array_elements(api.val_decisions() -> 'decidedProposals') d where d ->> 'matchValue' = 'npwz:lek:7000022'$$), 0, 'RD3-2: an open proposal is not listed');
select public.t_logout();

select * from finish();
rollback;
