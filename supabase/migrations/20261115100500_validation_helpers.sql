-- Validation rules in SQL (SPEC 6). The import worker computes the stored derived fields with the TypeScript twin
-- (app/src/features/validation/rules.ts); these functions are the database-side authority used when a decision
-- changes an account (val_account_link), to check rows on import, and by the tests that pin both to one behaviour.

-- NIP check (SPEC 6.3): 0 none, 1 ok, 2 bad format, 3 placeholder, 4 checksum.
create or replace function private.nip_status(p_nip text) returns smallint
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  w int[] := array[6, 5, 7, 2, 3, 4, 5, 6, 7];
  s int := 0;
  i int;
begin
  if p_nip is null or btrim(p_nip) = '' then return 0; end if;
  if p_nip !~ '^[0-9]{10}$' then return 2; end if;
  if p_nip ~ '^([0-9])\1{9}$' then return 3; end if;
  if left(p_nip, 1) = '0' then return 3; end if; -- real NIPs start with a tax-office code, never 0 (VAL-R3-9)
  for i in 1..9 loop
    s := s + substr(p_nip, i, 1)::int * w[i];
  end loop;
  if s % 11 = 10 or s % 11 <> substr(p_nip, 10, 1)::int then return 4; end if;
  return 1;
end $$;

-- E-mail normalisation and syntax (SPEC 6.4).
create or replace function private.normalize_email(p_email text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select nullif(lower(btrim(regexp_replace(regexp_replace(btrim(coalesce(p_email, '')), '^mailto:', '', 'i'), '^<(.*)>$', '\1'))), '')
$$;

create or replace function private.email_valid(p_email text) returns boolean
language sql immutable parallel safe set search_path = '' as $fn$
  select p_email ~ $re$^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$$re$
$fn$;

create or replace function private.email_domain(p_email text) returns text
language sql immutable parallel safe set search_path = '' as $$ select nullif(split_part(p_email, '@', 2), '') $$;

-- Role mailbox classes: 'front' (reception), 'office', or null (SPEC 6.4).
create or replace function private.email_role(p_email text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case
    when split_part(split_part(p_email, '@', 1), '+', 1) ~ '^(rejestracja|rejestr|recepcja|zapisy|przychodnia|poradnia|gabinet)' then 'front'
    when split_part(split_part(p_email, '@', 1), '+', 1) ~ '^(biuro|sekretariat|kontakt|info|office|poczta|administracja|kancelaria|centrala|mail|admin)' then 'office'
    else null end
$$;

-- Public second-level suffixes under which anyone registers a domain (VAL-R3-1). A generic_domain row for one of them matches
-- only that exact domain, never its sub-domains (rules.ts PUBLIC_SUFFIXES is the twin).
create or replace function private.public_suffix(p_domain text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select p_domain = any (array['com.pl','net.pl','org.pl','edu.pl','info.pl','biz.pl','waw.pl','lm.pl','med.pl','priv.pl','nom.pl',
    'shop.pl','sklep.pl','pc.pl','tm.pl','wroc.pl','gda.pl','krakow.pl','poznan.pl','lodz.pl','szczecin.pl','katowice.pl','lublin.pl',
    'bialystok.pl','torun.pl','olsztyn.pl','rzeszow.pl','opole.pl','kielce.pl','bydgoszcz.pl','gliwice.pl','gdynia.pl','sopot.pl',
    'com','net','org','pl','eu'])
$$;

-- Domain class from crm.generic_domain; 'generic' rows and 'free' rows also match every sub-domain (x.wp.pl is a mailbox host),
-- except rows for a public suffix (VAL-R3-1).
create or replace function private.domain_class(p_domain text) returns text
language sql stable set search_path = '' as $$
  select g.kind from crm.generic_domain g
  where g.domain = p_domain
     or (g.kind in ('generic', 'free') and p_domain like '%.' || g.domain and not private.public_suffix(g.domain))
  order by (g.domain = p_domain) desc limit 1
$$;

-- E-mail score 0-100 (SPEC 6.4).
create or replace function private.email_quality(p_email text, p_shared_accounts int, p_stale boolean) returns smallint
language plpgsql stable set search_path = '' as $$
declare
  v_mail text := private.normalize_email(p_email);
  v_class text;
  v_role text;
  v_score int := 100;
begin
  if v_mail is null or not private.email_valid(v_mail) then return 0; end if;
  v_class := private.domain_class(private.email_domain(v_mail));
  v_role := private.email_role(v_mail);
  if v_class = 'typo' then v_score := 10; end if;
  if v_class = 'free' then v_score := v_score - 15; end if;
  if v_role = 'front' then v_score := v_score - 15; elsif v_role = 'office' then v_score := v_score - 10; end if;
  if v_class = 'generic' then v_score := v_score - 5; end if;
  if coalesce(p_shared_accounts, 1) >= 6 then v_score := v_score - 20;
  elsif coalesce(p_shared_accounts, 1) >= 2 then v_score := v_score - 10; end if;
  if p_stale then v_score := v_score - 10; end if;
  return greatest(0, least(100, v_score))::smallint;
end $$;

-- Phone score (SPEC 6.4): class 'kom' | 'stac' | 'inny' | null (unparseable) and number of owning accounts.
create or replace function private.phone_quality(p_class text, p_owners int, p_stale boolean) returns smallint
language plpgsql immutable parallel safe set search_path = '' as $$
declare v_score int;
begin
  v_score := case p_class when 'kom' then 100 when 'stac' then 85 when 'inny' then 60 else null end;
  if v_score is null then return 0; end if;
  v_score := v_score - case when coalesce(p_owners, 1) >= 10 then 50 when coalesce(p_owners, 1) >= 5 then 35
                            when coalesce(p_owners, 1) >= 3 then 20 when coalesce(p_owners, 1) = 2 then 10 else 0 end;
  if p_stale then v_score := v_score - 10; end if;
  return greatest(0, least(100, v_score))::smallint;
end $$;

-- WWW host normalisation (SPEC 6.4): null when the value is junk or not a host name.
create or replace function private.normalize_www(p_www text) returns text
language plpgsql immutable parallel safe set search_path = '' as $$
declare v text := lower(btrim(coalesce(p_www, '')));
begin
  if v = '' or v ~ '\s' or v like '%@%' then return null; end if;
  if v in ('-', ',', 'brak', 'brak wpisu', 'nie dotyczy', 'n/d', 'nd', 'ul.', 'www', 'http', 'https') then return null; end if;
  v := regexp_replace(v, '^[a-z][a-z0-9+.-]*://', '');
  v := regexp_replace(v, '[/?#].*$', '');
  v := regexp_replace(v, ':[0-9]*$', '');
  v := regexp_replace(v, '^www2?\.', '');
  v := regexp_replace(v, '\.$', '');
  if v !~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$' then return null; end if;
  return v;
end $$;

-- Entity type (SPEC 6.1): 1 spolka/prawny, 2 JDG, 3 publiczny, 4 praktyka indywidualna, 5 praktyka grupowa.
-- p_form_type is the formType facet value ('komercyjna' | 'publiczna' | 'inna').
create or replace function private.entity_type(p_kind text, p_forma text, p_form_type text, p_typ text, p_src text)
returns smallint language sql immutable parallel safe set search_path = '' as $$
  select (case
    when p_kind = 'p' and p_form_type = 'publiczna' then 3
    when p_kind = 'p' and lower(coalesce(p_forma, '')) like 'działalność gospodarcza prowadzona przez osobę fizyczną%' then 2
    when p_kind = 'p' then 1
    when p_kind = 'r' and (lower(coalesce(p_typ, '')) = 'grupowa' or coalesce(p_src, '') like '%g') then 5
    else 4 end)::smallint
$$;

-- Recompute account_size and the primary entry for the given account keys (SPEC 6.2 point 4): podmiot first, then the
-- most contact data (4*tel + 2*email + 1*www), then the lowest key hash (unsigned, i.e. the hex string).
create or replace function private.recompute_accounts(p_keys text[]) returns int
language plpgsql set search_path = '' as $$
declare v_n int;
begin
  with ranked as (
    select e.id,
           count(*) over (partition by e.account_key) as sz,
           row_number() over (
             partition by e.account_key
             order by (e.kind <> 'p'),
                      (case when coalesce(e.tel, '') <> '' then 4 else 0 end
                       + case when coalesce(e.email, '') <> '' or cardinality(coalesce(e.emails, '{}')) > 0 then 2 else 0 end
                       + case when coalesce(e.www, '') <> '' then 1 else 0 end) desc,
                      private.hex16(e.key_hash)) as rn
    from crm.reg_entry e
    where e.account_key = any (p_keys)
  ), upd as (
    update crm.reg_entry e
    set account_size = least(r.sz, 32767)::smallint, is_account_primary = (r.rn = 1)
    from ranked r
    where e.id = r.id and (e.account_size <> least(r.sz, 32767) or e.is_account_primary <> (r.rn = 1))
    returning 1
  )
  select count(*) into v_n from upd;
  return v_n;
end $$;

select private.apply_api_grants();
