-- SYNTHETIC local seed (supabase db reset). Every name, NIP, e-mail, phone below is generated; none is real.
-- It never runs on the hosted project (supabase db push does not execute seed.sql).
-- Contents: 3 allowlist rows (example.test), one applied import run, 300 fake register entries (120 podmioty,
-- 180 praktyki) with deliberate edge cases (shared e-mail / domain / www / phone, shared NIP between a company and a
-- practice, bad NIP, typo domain, no contact), proposals computed from them, and a little CRM work.
-- Local sign-in: create auth users for these e-mails yourself (see docs/OPERATIONS.md "Lokalne środowisko").

create or replace function pg_temp.mk_nip(p_n int) returns text language plpgsql as $$
declare
  w int[] := array[6, 5, 7, 2, 3, 4, 5, 6, 7];
  base int := 100000000 + p_n * 13;
  d text; s int; i int; c int;
begin
  loop
    d := lpad(base::text, 9, '0'); s := 0;
    for i in 1..9 loop s := s + substr(d, i, 1)::int * w[i]; end loop;
    c := s % 11;
    if c < 10 then return d || c; end if;
    base := base + 1;
  end loop;
end $$;

create or replace function pg_temp.qflags(p_nip text, p_email text, p_tel text, p_stan date, p_www text) returns int
language sql as $$
  select (case private.nip_status(p_nip) when 0 then 1 when 2 then 2 when 3 then 4 when 4 then 8 else 0 end)
       | (case when p_email is null and p_tel is null then 16 else 0 end)
       | (case when p_email is not null and not private.email_valid(p_email) then 32 else 0 end)
       | (case when private.domain_class(private.email_domain(p_email)) = 'typo' then 64 else 0 end)
       | (case when private.domain_class(private.email_domain(p_email)) = 'free' then 128 else 0 end)
       | (case when private.email_role(p_email) is not null then 256 else 0 end)
       | (case when p_stan is null or p_stan <= date '2023-11-10' then 32768 else 0 end)
$$;

do $seed$
declare
  v_run  int;
  v_rows jsonb;
  v_org  constant text := 'Wojewoda Testowy (dane syntetyczne)';
  v_orgr constant text := 'Okręgowa Izba Testowa (dane syntetyczne)';
  v_owner smallint;
  v_anna  smallint;
  v_piotr smallint;
begin
  insert into crm.team_member (email, display_name, role, phone) values
    ('owner@example.test', 'Olga Właścicielka (test)', 'owner', '+48 600 000 001'),
    ('anna@example.test',  'Anna Handlowiec (test)',   'member', '+48 600 000 002'),
    ('piotr@example.test', 'Piotr Handlowiec (test)',  'member', '+48 600 000 003');
  select id into v_owner from crm.team_member where email = 'owner@example.test';
  select id into v_anna from crm.team_member where email = 'anna@example.test';
  select id into v_piotr from crm.team_member where email = 'piotr@example.test';

  insert into crm.import_run (status, file_name, index_version, hash_version, report_date, tool_today, sources, full_sources,
                              counts, started_by, finished_at)
  values ('applied', 'seed-synthetic.json.gz', 2, 1, date '2026-11-14', date '2026-11-14',
          '[{"id":"Rpm","records":120},{"id":"Rpz","records":60},{"id":"Rpzg","records":40},{"id":"Rpzp","records":40},{"id":"Rpf","records":40}]',
          array['Rpm', 'Rpz', 'Rpzg', 'Rpzp', 'Rpf'],
          '{"total":300,"new":300,"changed":0,"changedContact":0,"returned":0,"gone":0,"unchanged":0,"derivedOnly":0,"rejected":0}',
          v_owner, now())
  returning id into v_run;

  -- podmioty ---------------------------------------------------------------------------------------------------------
  select coalesce(jsonb_agg(r.row_json order by r.n), '[]') into v_rows from (
    select n, jsonb_build_object(
      'keyHash', k.hex, 'regKey', k.reg_key, 'kind', 'p', 'src', 'Rpm', 'org', v_org, 'ks', 'P-' || lpad(n::text, 5, '0'), 'kseq', 1,
      'name', 'Przychodnia Testowa ' || lpad(n::text, 3, '0') || case when n % 5 = 0 then ' Sp. z o.o.' else '' end,
      'nip', c.nip, 'email', c.email, 'tel', c.tel, 'www', c.www, 'emails', case when c.email is null then '[]'::jsonb else jsonb_build_array(c.email) end,
      'miasto', (array['Warszawa', 'Kraków', 'Gdańsk', 'Łódź'])[1 + n % 4], 'kod', '00-' || lpad((100 + n)::text, 3, '0'),
      'wpis', (date '2025-06-01' + n * 4)::text, 'stan', c.stan::text, 'nz', 1 + n % 3, 'nk', 1 + n % 12,
      'facets', jsonb_build_object(
        'p.status', jsonb_build_array('aktywny'),
        'p.rodzaje', case when n % 10 = 0 then jsonb_build_array('Ambulatoryjne świadczenia zdrowotne', 'Stacjonarne i całodobowe świadczenia zdrowotne szpitalne')
                          else jsonb_build_array('Ambulatoryjne świadczenia zdrowotne') end,
        'p.grp', case when n % 2 = 0 then jsonb_build_array('0') else jsonb_build_array('1', '3') end,
        'p.spec', case when n % 2 = 0 then jsonb_build_array('0016') else jsonb_build_array('1000', '1100', '1200') end,
        'p.dz', jsonb_build_array(case when n % 2 = 0 then 'Medycyna rodzinna' else 'Choroby wewnętrzne' end),
        'p.fn', jsonb_build_array(case when n % 3 = 0 then 'HC.1.3.3.' else 'HC.1.1.1.' end),
        'p.forma', jsonb_build_array(c.forma), 'p.formType', jsonb_build_array(c.form_type),
        'p.woj', jsonb_build_array((array['mazowieckie', 'małopolskie', 'pomorskie', 'łódzkie'])[1 + n % 4])),
      'derived', jsonb_build_object(
        'nipStatus', private.nip_status(c.nip),
        'entityType', private.entity_type('p', c.forma, c.form_type, null, 'Rpm'),
        'accountKey', case when private.nip_status(c.nip) = 1 then 'n:' || c.nip else 'e:' || k.hex end,
        'accountSize', 1, 'isAccountPrimary', true, 'telShared', null,
        'qEmail', case when c.email is null then null else private.email_quality(c.email, 1, c.stan <= date '2023-11-10') end,
        'qPhone', case when c.tel is null then null else private.phone_quality(case when c.mob then 'kom' else 'stac' end, 1, c.stan <= date '2023-11-10') end,
        'qflags', pg_temp.qflags(c.nip, c.email, c.tel, c.stan, c.www),
        'mobile', case when c.mob and c.tel is not null then regexp_replace(c.tel, '\D', '', 'g') end,
        'telNorm', regexp_replace(c.tel, '\D', '', 'g'),
        'nums', case when c.tel is null then '[]'::jsonb else jsonb_build_array(regexp_replace(c.tel, '\D', '', 'g')) end,
        'formType', c.form_type, 'spec1', n % 8),
      'rec', jsonb_build_object(
        'emails', case when c.email is null then '[]'::jsonb else jsonb_build_array(c.email) end,
        'phones', case when c.tel is null then '[]'::jsonb else jsonb_build_array(c.tel) end,
        'ulica', 'ul. Testowa ' || n,
        'rodzaje', jsonb_build_array('Ambulatoryjne świadczenia zdrowotne'),
        'dz', jsonb_build_array('Medycyna rodzinna'), 'fn', jsonb_build_array('HC.1.1.1.'),
        'd', jsonb_build_object('ks', 'P-' || lpad(n::text, 5, '0'), 'org', v_org, 'zm', '2023-11-10', 'st', '2020-01-01',
             'sie', 'ul. Testowa ' || n || ', 00-' || lpad((100 + n)::text, 3, '0') || ' ' || (array['Warszawa', 'Kraków', 'Gdańsk', 'Łódź'])[1 + n % 4],
             'z', jsonb_build_array(jsonb_build_object('n', 'Zakład leczniczy ' || n, 'r', 0, 'a', 'ul. Testowa ' || n,
                   'k', jsonb_build_array(jsonb_build_object('n', 'Poradnia ' || n, 's', case when n % 2 = 0 then '0016' else '1000' end, 'dz', jsonb_build_array(0), 'fn', jsonb_build_array(0)))))
             )),
      'hAll', k.hash::text, 'hContact', '1', 'hDerived', '1') as row_json
    from generate_series(1, 120) n
    cross join lateral (select case when n % 5 = 0 then 'spółka z ograniczoną odpowiedzialnością'
                                    when n % 5 = 1 then 'działalność gospodarcza prowadzona przez osobę fizyczną'
                                    when n % 5 = 2 then 'samodzielny publiczny zakład opieki zdrowotnej'
                                    when n % 5 = 3 then 'fundacja' else 'spółka jawna' end as forma) f
    cross join lateral (select case f.forma when 'samodzielny publiczny zakład opieki zdrowotnej' then 'publiczna' when 'fundacja' then 'inna' else 'komercyjna' end as form_type) ft
    cross join lateral (select
        case when n = 13 then '1234567890' when n = 14 then '0000000000' when n = 15 then null else pg_temp.mk_nip(n) end as nip,
        case when n in (1, 2, 3) then 'poz' || n || '@siec-testowa.example'
             when n in (4, 5) then 'biuro@duplikat-klinika.example'
             when n = 10 then 'kontakt@gmial.com'
             when n = 11 then 'przychodnia11@gmail.com'
             when n = 12 then 'brak-malpy'
             when n = 16 then null
             when n % 7 = 0 then 'rejestracja@klinika' || n || '.example'
             else 'kontakt' || n || '@klinika' || n || '.example' end as email,
        case when n = 16 then null
             when n in (8, 9) then '22 6000008'
             when n % 3 = 0 then '600 ' || substr(lpad(n::text, 6, '0'), 1, 3) || ' ' || substr(lpad(n::text, 6, '0'), 4, 3)
             else '22 7' || lpad(n::text, 6, '0') end as tel,
        case when n in (6, 7) then 'https://www.wspolna-strona.example/' when n % 4 = 0 then 'www.klinika' || n || '.example' else null end as www,
        case when n % 3 = 0 then date '2023-11-10' else date '2026-01-01' + n end as stan,
        n % 3 = 0 and n not in (8, 9, 16) as mob,
        f.forma as forma, ft.form_type as form_type) c
    cross join lateral (select 'Rpm|' || v_org || '|P-' || lpad(n::text, 5, '0') || '|1' as reg_key) rk
    cross join lateral (select private.key_hash_of(rk.reg_key) as hash, private.hex16(private.key_hash_of(rk.reg_key)) as hex, rk.reg_key) k
  ) r;
  perform private.import_entries_core(v_run, v_rows);

  -- praktyki ---------------------------------------------------------------------------------------------------------
  select coalesce(jsonb_agg(r.row_json order by r.n), '[]') into v_rows from (
    select n, jsonb_build_object(
      'keyHash', k.hex, 'regKey', k.reg_key, 'kind', 'r', 'src', c.src, 'org', v_orgr, 'ks', 'R-' || lpad(n::text, 6, '0'), 'kseq', 1,
      'name', case when c.grp then 'Grupowa Praktyka Testowa ' || n else 'Indywidualna Praktyka Testowa ' || n end,
      'nip', c.nip, 'email', null, 'tel', c.tel, 'www', c.www, 'emails', '[]'::jsonb,
      'miasto', (array['Warszawa', 'Kraków', 'Gdańsk', 'Łódź'])[1 + n % 4], 'kod', '01-' || lpad((200 + n)::text, 3, '0'),
      'wpis', (date '2025-03-01' + n * 3)::text, 'stan', c.stan::text, 'nz', null, 'nk', null,
      'facets', jsonb_build_object(
        'r.src', jsonb_build_array(c.src), 'r.grupaPraktyk', jsonb_build_array(case when c.grp then 'grupowa' else 'indywidualna' end),
        'r.gz', jsonb_build_array((array['lekarz', 'pielęgniarka', 'fizjoterapeuta'])[1 + n % 3]),
        'r.typ', jsonb_build_array(case when c.grp then 'grupowa' else 'indywidualna' end),
        'r.rodzaj', jsonb_build_array('Praktyka zawodowa'), 'r.rd', jsonb_build_array('Ambulatoryjne świadczenia zdrowotne'),
        'r.spec', jsonb_build_array((array['Choroby wewnętrzne', 'Pediatria', 'Kardiologia'])[1 + n % 3]),
        'r.zakres', jsonb_build_array('Lecznicze'), 'r.forma', jsonb_build_array('praktyka'), 'r.organ', jsonb_build_array(v_orgr),
        'r.status', jsonb_build_array(case when n % 25 = 0 then 'suspended' else 'active' end),
        'r.woj', jsonb_build_array((array['mazowieckie', 'małopolskie', 'pomorskie', 'łódzkie'])[1 + n % 4])),
      'derived', jsonb_build_object(
        'nipStatus', private.nip_status(c.nip),
        'entityType', private.entity_type('r', null, null, case when c.grp then 'grupowa' end, c.src),
        'accountKey', case when private.nip_status(c.nip) = 1 then 'n:' || c.nip else 'e:' || k.hex end,
        'accountSize', 1, 'isAccountPrimary', true, 'telShared', null, 'qEmail', null,
        'qPhone', private.phone_quality(case when c.tel ~ '^5' then 'kom' else 'stac' end, 1, c.stan <= date '2023-11-10'),
        'qflags', pg_temp.qflags(c.nip, null, c.tel, c.stan, c.www),
        'mobile', case when c.tel ~ '^5' then regexp_replace(c.tel, '\D', '', 'g') end,
        'telNorm', regexp_replace(c.tel, '\D', '', 'g'),
        'nums', jsonb_build_array(regexp_replace(c.tel, '\D', '', 'g')), 'formType', null, 'spec1', null),
      'rec', jsonb_build_object(
        'phones', jsonb_build_array(c.tel), 'ulica', 'ul. Praktyczna ' || n,
        'rodzaj', jsonb_build_array('Praktyka zawodowa'), 'rd', jsonb_build_array('Ambulatoryjne świadczenia zdrowotne'),
        'd', jsonb_build_object('ks', 'R-' || lpad(n::text, 6, '0'), 'zm', c.stan::text, 'st', '2021-05-01', 'tyt', 'lek.',
             'npwz', (1000000 + n)::text, 'kor', 'ul. Praktyczna ' || n,
             'sp', jsonb_build_array(jsonb_build_array('Choroby wewnętrzne', 'II stopień')),
             'a', jsonb_build_array(jsonb_build_object('t', 0, 'ta', 0, 'zk', 2, 'ad', jsonb_build_array(jsonb_build_array(0, 'ul. Praktyczna ' || n, c.tel)))),
             'w', case when c.grp then jsonb_build_array(jsonb_build_object('n', 'Partner Testowy ' || n, 'nip', c.nip, 'npwz', (2000000 + n)::text)) else '[]'::jsonb end)),
      'hAll', k.hash::text, 'hContact', '1', 'hDerived', '1') as row_json
    from generate_series(1, 180) n
    cross join lateral (select
        (array['Rpz', 'Rpzg', 'Rpzp', 'Rpf'])[1 + n % 4] as src,
        n % 4 = 1 as grp,
        case when n <= 20 then pg_temp.mk_nip(n)           -- same NIP as podmiot n: company + practice share an account
             when n = 30 then '9999999999' else pg_temp.mk_nip(1000 + n) end as nip,
        case when n in (40, 41) then '501 000 040' else '5' || lpad((n * 7)::text, 2, '0') || ' ' || substr(lpad(n::text, 6, '0'), 1, 3) || ' ' || substr(lpad(n::text, 6, '0'), 4, 3) end as tel,
        case when n % 9 = 0 then 'praktyka' || n || '.example' else null end as www,
        case when n % 2 = 0 then date '2023-11-10' else date '2026-02-01' + n end as stan) c
    cross join lateral (select c.src || '|' || v_orgr || '|R-' || lpad(n::text, 6, '0') || '|1' as reg_key) rk
    cross join lateral (select private.key_hash_of(rk.reg_key) as hash, private.hex16(private.key_hash_of(rk.reg_key)) as hex, rk.reg_key) k
  ) r;
  perform private.import_entries_core(v_run, v_rows);

  perform private.recompute_accounts((select array_agg(distinct account_key) from crm.reg_entry));

  -- labels (the real index header carries names; synthetic ones here)
  update crm.reg_dict set label = case val when '0' then 'Podstawowa opieka zdrowotna' when '1' then 'Poradnie specjalistyczne' when '3' then 'Poradnie diagnostyczne' else label end where facet = 'p.grp';
  update crm.reg_dict set label = val || ' — poradnia testowa' where facet = 'p.spec';

  -- proposals computed from the seed (the real ones come from the import worker)
  insert into crm.val_proposal (kind, match_value, confidence, group_key, members, last_run)
  select p.kind, p.match_value, p.confidence, left(encode(sha256(convert_to(array_to_string(p.members, ','), 'UTF8')), 'hex'), 16), p.members, v_run
  from (
    select 'email' as kind, private.normalize_email(e.email) as match_value, 85::smallint as confidence, array_agg(distinct e.account_key order by e.account_key) as members
      from crm.reg_entry e where e.email is not null and private.email_valid(private.normalize_email(e.email))
      group by 2 having count(distinct e.account_key) between 2 and 30
    union all
    select 'domain', private.email_domain(private.normalize_email(e.email)), 70, array_agg(distinct e.account_key order by e.account_key)
      from crm.reg_entry e where e.email is not null and private.email_valid(private.normalize_email(e.email))
        and private.domain_class(private.email_domain(private.normalize_email(e.email))) is null
      group by 2 having count(distinct e.account_key) between 2 and 50
    union all
    select 'www', private.normalize_www(e.www), 80, array_agg(distinct e.account_key order by e.account_key)
      from crm.reg_entry e where private.normalize_www(e.www) is not null and private.domain_class(private.normalize_www(e.www)) is null
      group by 2 having count(distinct e.account_key) between 2 and 50
    union all
    select 'phone', n::text, 50, array_agg(distinct e.account_key order by e.account_key)
      from crm.reg_entry e cross join lateral unnest(e.nums) n where e.nums is not null
      group by 2 having count(distinct e.account_key) between 2 and 3
    union all
    select 'account_check', e.account_key, 60, array[e.account_key]
      from crm.reg_entry e where e.account_size > 1 group by e.account_key
      having bool_or(e.entity_type in (1, 3)) and bool_or(e.entity_type in (4, 5))
  ) p
  where not (p.kind = 'domain' and exists (select 1 from crm.val_proposal x where x.kind = 'email'
        and x.members = p.members));
  update crm.reg_entry e set qflags = qflags | 524288
  where e.account_key in (select members[1] from crm.val_proposal where kind = 'account_check');

  -- a little CRM work, so the screens are not empty
  insert into crm.tag (name, color) values ('Priorytet', '#dc2626'), ('Sieć', '#2563eb');
  insert into crm.list (name, note, created_by) values ('Kampania testowa', 'Lista przykładowa (dane syntetyczne)', v_owner);
  perform private.ensure_lead(e.id, v_owner) from crm.reg_entry e where e.kind = 'p' and e.ks in ('P-00001', 'P-00002', 'P-00003', 'P-00004');
  update crm.lead set owner_id = v_anna, status_id = (select id from crm.lead_status where name = 'Do kontaktu'),
         next_step_at = (now() at time zone 'Europe/Warsaw')::date, next_step_note = 'Oddzwonić do rejestracji', tags = array[(select id from crm.tag where name = 'Priorytet')]
   where entry_id in (select id from crm.reg_entry where ks = 'P-00001');
  update crm.lead set owner_id = v_piotr, status_id = (select id from crm.lead_status where name = 'Zainteresowany')
   where entry_id in (select id from crm.reg_entry where ks = 'P-00002');
  insert into crm.list_member (list_id, entry_id, added_by)
    select (select id from crm.list limit 1), id, v_owner from crm.reg_entry where ks in ('P-00001', 'P-00002', 'P-00003');
  insert into crm.activity (entry_id, type, outcome, body, occurred_at, created_by)
    select id, 'call', 'poczta_glosowa', 'Nagrano wiadomość (dane syntetyczne).', now() - interval '2 days', v_anna from crm.reg_entry where ks = 'P-00001';
  update crm.lead set last_contact_at = now() - interval '2 days' where entry_id in (select id from crm.reg_entry where ks = 'P-00001');
  insert into crm.task (entry_id, title, due_date, assignee_id, created_by)
    select id, 'Wysłać ofertę (zadanie przykładowe)', (now() at time zone 'Europe/Warsaw')::date, v_piotr, v_owner from crm.reg_entry where ks = 'P-00002';
end
$seed$;

analyze crm.reg_entry;
