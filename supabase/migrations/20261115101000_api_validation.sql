-- api: validation queues, decisions, account links, networks (CONTRACT 5; SPEC 4.7, 6).

-- Account keys of the entries selected by a filter, or null when no filter is given. An empty object selects every lead, so it
-- is treated like null: building a ~250 k key array for `members && v_acc` took 19 s (RDV-4).
create or replace function private.filter_accounts(p_filter jsonb, p_me smallint) returns text[]
language plpgsql stable set search_path = '' as $$
declare v_keys text[];
begin
  if p_filter is null or jsonb_typeof(p_filter) = 'null' or p_filter = '{}'::jsonb then return null; end if;
  execute format('select coalesce(array_agg(distinct e.account_key), ''{}'') from crm.reg_entry e left join crm.lead l on l.entry_id = e.id where %s',
                 private.compile_filter(p_filter, p_me)) into v_keys;
  return v_keys;
end $$;

create or replace function api.val_summary(p_filter jsonb) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '50s' as $$
declare
  v_me   smallint := private.require_member();
  v_acc  text[] := private.filter_accounts(p_filter, v_me);
  v_rec  jsonb;
  v_min  int := private.min_conf();
begin
  execute format(
    'select jsonb_build_object(''doSprawdzenia'', count(*) filter (where v = 1), ''zweryfikowany'', count(*) filter (where v = 2), ''odrzucony'', count(*) filter (where v = 3), ''niezweryfikowany'', count(*) filter (where v = 0)) from (select coalesce(l.validation, case when (e.qflags & %s) <> 0 or e.account_key in (select account_key from crm.v_open_member) then 1 else 0 end) as v from crm.reg_entry e left join crm.lead l on l.entry_id = e.id where %s) s',
    private.qflag_problem_mask(), private.compile_filter(coalesce(case when jsonb_typeof(p_filter) = 'object' then p_filter end, '{}'::jsonb), v_me))
    into v_rec;
  return jsonb_build_object(
    'queues', jsonb_build_object(
      'accounts', (select jsonb_build_object('open', count(*) filter (where status = 0), 'decided', count(*) filter (where status in (1, 2)))
                   from crm.val_proposal where kind in ('account_check', 'person', 'reg_duplicate') and confidence >= v_min
                     and (v_acc is null or members && v_acc)),
      'networks', (select jsonb_build_object('open', count(*) filter (where status = 0), 'decided', count(*) filter (where status in (1, 2)))
                   from crm.val_proposal where kind in ('email', 'domain', 'www', 'phone', 'partner') and confidence >= v_min
                     and (v_acc is null or members && v_acc)),
      'records', jsonb_build_object('open', (v_rec ->> 'doSprawdzenia')::int,
                                    'decided', (v_rec ->> 'zweryfikowany')::int + (v_rec ->> 'odrzucony')::int)),
    'byKind', (select coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb)
               from (select kind, count(*) as n from crm.val_proposal
                     where status = 0 and confidence >= v_min and (v_acc is null or members && v_acc) group by kind) k),
    'records', v_rec);
end $$;

create or replace function api.val_queue(p_queue text, p_status smallint, p_filter jsonb, p_offset int, p_limit int) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '50s' as $$
declare
  v_me    smallint := private.require_member();
  v_acc   text[] := private.filter_accounts(p_filter, v_me);
  v_kinds text[];
begin
  if p_limit is not null and p_limit > 200 then perform private.raise_err('CR413', 'too_many_rows', 'limit above 200'); end if;
  if p_queue not in ('accounts', 'networks') or p_limit is null or p_limit < 1 or p_offset is null or p_offset < 0 then
    perform private.raise_err('CR422', 'invalid_payload', 'queue accounts|networks (the records queue is leads_search with validation [1])');
  end if;
  v_kinds := case p_queue when 'accounts' then array['account_check', 'person', 'reg_duplicate']
                          else array['email', 'domain', 'www', 'phone', 'partner'] end;
  return (select coalesce(jsonb_agg(private.proposal_json(p) order by p.confidence desc, cardinality(p.members) desc, p.id), '[]')
          from (select * from crm.val_proposal x
                where x.kind = any (v_kinds) and x.confidence >= private.min_conf()
                  and (p_status is null or x.status = p_status)
                  and (v_acc is null or x.members && v_acc)
                order by x.confidence desc, cardinality(x.members) desc, x.id
                limit p_limit offset p_offset) p);
end $$;

create or replace function api.val_proposal_get(p_id int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_member();
  p    crm.val_proposal;
begin
  select * into p from crm.val_proposal where id = p_id;
  if not found then perform private.raise_err('CR404', 'not_found', 'proposal ' || p_id); end if;
  return private.proposal_json(p) || jsonb_build_object('entries', private.lead_rows(
    (select coalesce(array_agg(s.id), '{}') from
      (select e.id from crm.reg_entry e where e.account_key = any (p.members) order by e.account_key, e.id limit 100) s)))
    -- the entries a reject ("to różne podmioty") detaches, so the card shows exactly what the database will do (VAL-R5-1)
    || case when p.kind = 'account_check' and p.status = 0
            then jsonb_build_object('detachIds', (select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
                                                  from unnest(p.members) k, unnest(private.minority_entries(k)) x))
            else '{}'::jsonb end;
end $$;

-- Individual practices (entity type 4) of the given profession source in the given accounts, with the licence number from
-- their register detail (rec.d.npwz). Used by val_decide on a 'person' proposal (VAL-R3-2).
create or replace function private.person_practices(p_keys text[], p_src smallint)
returns table (id int, account_key text, npwz text) language sql stable set search_path = '' as $$
  select e.id, e.account_key, nullif(btrim((b.recs::jsonb) -> e.id::text -> 'd' ->> 'npwz'), '')
  from crm.reg_entry e left join crm.reg_detail_block b on b.block_no = (e.id >> 5)
  where e.account_key = any (p_keys) and e.entity_type = 4 and e.src = p_src
$$;

-- Lower-case name tokens with diacritics folded ('Śliwa' / 'sliwa', 'Tešťák' / 'testak': every Latin-1 and Latin Extended-A/B
-- letter that decomposes to a base letter, plus ł ø đ ı ħ ŧ, and ß æ œ as ss ae oe; VAL-R5-5); twin of derive.ts foldedTokenList.
create or replace function private.name_tokens(p_name text) returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(array_agg(x.t order by x.o), '{}'::text[])
  from regexp_split_to_table(
         replace(replace(replace(lower(translate(coalesce(p_name, ''),
           'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĨĩĪīĬĭĮįİĴĵĶķĹĺĻļĽľŃńŅņŇňŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžƠơƯưǍǎǏǐǑǒǓǔǕǖǗǘǙǚǛǜǞǟǠǡǦǧǨǩǪǫǬǭǰǴǵǸǹǺǻȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȞȟȦȧȨȩȪȫȬȭȮȯȰȱȲȳłŁøØđĐıħĦŧŦ',
           'aaaaaaceeeeiiiinooooouuuuyaaaaaaceeeeiiiinooooouuuuyyaaaaaaccccccccddeeeeeeeeeegggggggghhiiiiiiiiijjkkllllllnnnnnnoooooorrrrrrssssssssttttuuuuuuuuuuuuwwyyyzzzzzzoouuaaiioouuuuuuuuuuaaaaggkkoooojggnnaaaaaaeeeeiiiioooorrrruuuusstthhaaeeooooooooyyllooddihhtt')),
           'ß', 'ss'), 'æ', 'ae'), 'œ', 'oe'),
         '[^a-z0-9]+') with ordinality as x(t, o)
  where x.t <> ''
$$;

-- Name tokens of a person: name_tokens without a leading 'osoba fizyczna' (a register prefix of sole traders, VAL-R3-8);
-- twin of derive.ts personTokens.
create or replace function private.person_tokens(p_name text) returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select case when t[1:2] = array['osoba', 'fizyczna'] then t[3:] else t end from (select private.name_tokens(p_name) as t) s
$$;

-- A licence number that identifies somebody: trimmed, at least 4 characters, not one repeated character ('0000000');
-- twin of the worker's npwzOf / licenceOf.
create or replace function private.licence(p_npwz text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case when length(btrim(p_npwz)) >= 4 and btrim(p_npwz) !~ '^(.)\1*$' then btrim(p_npwz) end
$$;

-- Every token of p_small has its own counterpart in p_big (equal, or an initial of it); twin of derive.ts nestedNames.
create or replace function private.tokens_nest(p_small text[], p_big text[]) returns boolean
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_used  boolean[];
  v_t     text;
  v_j     int;
  v_found boolean;
begin
  if cardinality(p_small) = 0 or cardinality(p_small) > cardinality(p_big) then return false; end if;
  v_used := array_fill(false, array[cardinality(p_big)]);
  foreach v_t in array p_small loop
    v_found := false;
    for v_j in 1 .. cardinality(p_big) loop
      if not v_used[v_j] and (p_big[v_j] = v_t or (length(v_t) = 1 and left(p_big[v_j], 1) = v_t)
                              or (length(p_big[v_j]) = 1 and left(v_t, 1) = p_big[v_j])) then
        v_used[v_j] := true;
        v_found := true;
        exit;
      end if;
    end loop;
    if not v_found then return false; end if;
  end loop;
  return true;
end $$;

-- Two register names can name the same person (VAL-R5-1, VAL-R5-2; twin of derive.ts samePersonTokens): one nests in the other
-- ('Jan Test' / 'Gabinet Jan Maria Test', initials allowed), or the first token of either, when it is not an initial (the first
-- name), occurs among the tokens of the other (a changed surname: 'Anna Test' / 'Anna Maria Próba'). A shared surname alone is
-- not enough ('Robert Test' / 'Urszula Test' are two people), nor is a first initial ('R. Test' / 'U. Test'). p_nest_only turns the
-- first-name branch off: callers pass it for two individual practices of one profession that carry different valid licence
-- numbers, where a shared first name does not make one person ('Anna Testowa' / 'Anna Próbna'; VAL-R6-1).
create or replace function private.same_person(p_a text, p_b text, p_nest_only boolean default false) returns boolean
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_a text[] := private.person_tokens(p_a);
  v_b text[] := private.person_tokens(p_b);
begin
  if cardinality(v_a) = 0 or cardinality(v_b) = 0 then return false; end if;
  if private.tokens_nest(v_a, v_b) or private.tokens_nest(v_b, v_a) then return true; end if;
  if p_nest_only then return false; end if;
  return (length(v_a[1]) > 1 and v_a[1] = any (v_b)) or (length(v_b[1]) > 1 and v_b[1] = any (v_a));
end $$;

-- Detach an entry from its account, or attach it to another one; stores the decision (CONTRACT 6, SPEC 6.8) and writes
-- a validation activity. Returns the two affected account keys (old, new). The caller recomputes account sizes.
create or replace function private.account_link(p_entry int, p_action text, p_target text, p_note text, p_me smallint)
returns text[] language plpgsql set search_path = '' as $$
declare
  e       crm.reg_entry;
  v_old   crm.val_decision;
  v_new   text;
  v_body  text;
  v_pm    text;
begin
  select * into e from crm.reg_entry where id = p_entry for update;
  if not found then perform private.raise_err('CR404', 'not_found', 'entry ' || p_entry); end if;
  select * into v_old from crm.val_decision where key_hash = e.key_hash;
  if p_action = 'detach' then
    v_new := 'e:' || private.hex16(e.key_hash);
  elsif p_action = 'attach' then
    if p_target is null or btrim(p_target) = '' then perform private.raise_err('CR422', 'invalid_payload', 'accountKey is required'); end if;
    if not exists (select 1 from crm.reg_entry x where x.account_key = p_target and x.id <> e.id) then
      perform private.raise_err('CR404', 'not_found', 'account ' || left(p_target, 60));
    end if;
    v_new := p_target;
  else
    perform private.raise_err('CR422', 'invalid_payload', 'action must be detach|attach');
  end if;
  insert into crm.val_decision (action, key_hash, account_key, note, decided_by, decided_at)
  values (p_action, e.key_hash, case when p_action = 'attach' then v_new end, p_note, p_me, now())
  on conflict (key_hash) do update set action = excluded.action, account_key = excluded.account_key, note = excluded.note,
    decided_by = excluded.decided_by, decided_at = excluded.decided_at;
  -- an open 'person' proposal for this practice's licence follows the practice into its new account, so "split the account
  -- first, then accept the person" works before the next import re-derives the members (VAL-R4-2)
  if e.entity_type = 4 and e.src in (1, 3, 5, 7) then
    select 'npwz:' || case e.src when 1 then 'lek' when 3 then 'piel' when 5 then 'fizjo' else 'diag' end || ':' || x.npwz into v_pm
    from private.person_practices(array[e.account_key], e.src) x where x.id = e.id;
    if v_pm is not null then
      update crm.val_proposal p set members = (select array_agg(distinct m order by m) from unnest(p.members || v_new) m)
      where p.kind = 'person' and p.status = 0 and p.match_value = v_pm and v_new <> all (p.members);
    end if;
  end if;
  update crm.reg_entry set account_key = v_new where id = e.id;
  v_body := case p_action when 'detach' then 'Odłączono od konta ' || e.account_key else 'Dołączono do konta ' || v_new || ' (z ' || e.account_key || ')' end
            || coalesce(' — ' || p_note, '')
            || case when v_old.id is not null then ' [zastąpiono wcześniejszą decyzję: ' || v_old.action || coalesce(' ' || v_old.account_key, '') || ']' else '' end;
  perform private.write_activity(e.id, 'validation', p_me, v_body);
  return array[e.account_key, v_new];
end $$;

create or replace function api.val_account_link(p_entry_id int, p_action text, p_account_key text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me   smallint := private.require_member();
  v_keys text[];
begin
  v_keys := private.account_link(p_entry_id, p_action, p_account_key, private.patch_text(jsonb_build_object('n', p_note), 'n', 2000), v_me);
  perform private.recompute_accounts(v_keys);
  return private.lead_rows((select coalesce(array_agg(s.id), '{}') from
    (select e.id from crm.reg_entry e where e.account_key = any (v_keys) order by e.account_key, e.id limit 100) s));
end $$;

-- Entries to detach when an account_check proposal is rejected. An account that mixes companies / public bodies (types 1, 3)
-- with practices (4, 5): the minority group (ties: the practices are the minority). An account without a company (a JDG with
-- practices, or practices only; VAL-R4-1, VAL-R4-2, VAL-R4-4, VAL-R5-1, VAL-R5-2): the individual practices of somebody else
-- than the reference person, who is the JDG's person (names of the type-2 entries) or, without a JDG, the account primary. A
-- practice stays when private.same_person matches it with the reference, or when it carries a reference licence number of its
-- profession (the primary practice's; with a JDG, those of the practices whose names nest with a JDG name): the same number is
-- the same person whatever the name. A different number of the same register does not make another person (a doctor's and a
-- dentist's number, a nurse's and a midwife's: 249 one-name practice accounts on the real file). Twin of derive.ts detachedPractices.
create or replace function private.minority_entries(p_account_key text) returns int[]
language plpgsql stable set search_path = '' as $$
declare
  v_ids     int[];
  v_has_jdg boolean;
  v_ref     text[];
begin
  if exists (select 1 from crm.reg_entry where account_key = p_account_key and entity_type in (1, 3)) then
    with grp as (select id, (entity_type in (1, 3)) as big from crm.reg_entry where account_key = p_account_key),
         cnt as (select count(*) filter (where big) as n_big, count(*) filter (where not big) as n_small from grp)
    select coalesce(array_agg(g.id order by g.id), '{}'::int[]) into v_ids from grp g, cnt c where g.big = (c.n_big < c.n_small);
    return v_ids;
  end if;
  v_has_jdg := exists (select 1 from crm.reg_entry where account_key = p_account_key and entity_type = 2);
  select coalesce(array_agg(e.name), '{}'::text[]) into v_ref from crm.reg_entry e
  where e.account_key = p_account_key and (case when v_has_jdg then e.entity_type = 2 else e.is_account_primary end);
  with pr as (
         select e.id, e.src, e.name, e.is_account_primary as prim,
                private.licence((b.recs::jsonb) -> e.id::text -> 'd' ->> 'npwz') as lic
         from crm.reg_entry e left join crm.reg_detail_block b on b.block_no = (e.id >> 5)
         where e.account_key = p_account_key and e.entity_type = 4),
       refl as (select pr.src, pr.lic from pr
                where pr.lic is not null
                  and (case when v_has_jdg
                            then exists (select 1 from unnest(v_ref) r
                                         where private.tokens_nest(private.person_tokens(r), private.person_tokens(pr.name))
                                            or private.tokens_nest(private.person_tokens(pr.name), private.person_tokens(r)))
                            else pr.prim end)),
       -- the reference entries: with no JDG the account primary, a practice when it is of type 4 (VAL-R6-1)
       refe as (select e.name, (e.entity_type = 4) as prac, e.src,
                       private.licence((b.recs::jsonb) -> e.id::text -> 'd' ->> 'npwz') as lic
                from crm.reg_entry e left join crm.reg_detail_block b on b.block_no = (e.id >> 5)
                where e.account_key = p_account_key and (case when v_has_jdg then e.entity_type = 2 else e.is_account_primary end))
  select coalesce(array_agg(pr.id order by pr.id), '{}'::int[]) into v_ids
  from pr
  where (v_has_jdg or not pr.prim)
    and not exists (select 1 from refl where refl.src = pr.src and refl.lic = pr.lic)
    -- nest-only between two practices of one profession with different valid licence numbers (VAL-R6-1)
    and not exists (select 1 from refe r
                    where private.same_person(r.name, pr.name, r.prac and r.src = pr.src and r.lic is not null and pr.lic is not null and r.lic <> pr.lic));
  return v_ids;
end $$;

create or replace function api.val_decide(p_id int, p_decision jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me      smallint := private.require_member();
  p         crm.val_proposal;
  d         text := p_decision ->> 'decision';
  v_note    text := private.patch_text(p_decision, 'note', 2000);
  v_members text[];
  v_net     int;
  v_name    text;
  v_keys    text[] := '{}';
  v_k       text;
  v_entry   int;
  v_target  text;
  v_lic     text;
  v_src     smallint;
  v_lic_keys text[];
begin
  select * into p from crm.val_proposal where id = p_id for update;
  if not found then perform private.raise_err('CR404', 'not_found', 'proposal ' || p_id); end if;

  if d = 'accept' then
    v_members := p.members;
    if jsonb_typeof(p_decision -> 'memberKeys') = 'array' then
      select array_agg(x) into v_members from jsonb_array_elements_text(p_decision -> 'memberKeys') x;
      if v_members is null or not (v_members <@ p.members) then
        perform private.raise_err('CR422', 'invalid_payload', 'memberKeys must be members of the proposal');
      end if;
    end if;
    if p.kind in ('email', 'domain', 'www', 'phone', 'partner') then
      if cardinality(v_members) < 2 then perform private.raise_err('CR422', 'invalid_payload', 'memberKeys: at least two accounts'); end if;
      if p_decision ->> 'networkId' is not null then
        v_net := (p_decision ->> 'networkId')::int;
        if not exists (select 1 from crm.network where id = v_net) then perform private.raise_err('CR404', 'not_found', 'network ' || v_net); end if;
      else
        v_name := coalesce(private.patch_text(p_decision, 'newNetworkName', 200),
          (select e.name from crm.reg_entry e where e.account_key = v_members[1] order by e.is_account_primary desc, e.id limit 1),
          'Sieć ' || p.id);
        begin
          insert into crm.network (name, created_by) values (v_name, v_me) returning id into v_net;
        exception when unique_violation then
          if p_decision ->> 'newNetworkName' is not null then
            perform private.raise_err('CR409', 'duplicate_name', 'a network with this name exists');
          end if;
          insert into crm.network (name, created_by) values (v_name || ' #' || p.id, v_me) returning id into v_net;
        end;
      end if;
      insert into crm.network_member (account_key, network_id, added_by)
      select x, v_net, v_me from unnest(v_members) x
      on conflict (account_key) do update set network_id = excluded.network_id, added_by = excluded.added_by, added_at = now();
      update crm.network set updated_at = now() where id = v_net;
      for v_k in select unnest(v_members) loop
        select e.id into v_entry from crm.reg_entry e where e.account_key = v_k order by e.is_account_primary desc, e.id limit 1;
        if v_entry is not null then
          perform private.write_activity(v_entry, 'validation', v_me,
            'Sieć: ' || (select name from crm.network where id = v_net) || ' (propozycja: ' || p.kind || ' ' || left(p.match_value, 80) || ')');
        end if;
      end loop;
    else
      -- accounts queue: "to ten sam podmiot". Entries of one person under different NIPs are merged into one account.
      if p.kind = 'person' and cardinality(v_members) > 1 then
        -- safeguard (VAL-R2-1): a group practice is never merged into a person's account, however the proposal was built
        if exists (select 1 from crm.reg_entry e where e.account_key = any (v_members) and e.entity_type = 5) then
          perform private.raise_err('CR422', 'invalid_payload', 'a group practice cannot be merged as "the same person"; use the partner link');
        end if;
        -- VAL-R3-2: an account that mixes a company / public body (1, 3) with practices, or that holds a practice of the same
        -- profession under another licence number and another person's name, carries other people's entries: the team resolves it first ("Rozdziel ten
        -- wpis" or the account_check proposal). The import's ACCOUNT_CHECK bit (19) counts only while the account still has
        -- more than one entry and its account_check proposal is undecided: after a split the stale bit no longer refuses (VAL-R4-2).
        v_lic := substring(p.match_value from '^npwz:[a-z]+:(.+)$');
        v_src := case split_part(p.match_value, ':', 2) when 'lek' then 1 when 'piel' then 3 when 'fizjo' then 5 when 'diag' then 7 end;
        if v_lic is null or v_src is null then
          perform private.raise_err('CR422', 'invalid_payload', 'person proposal value must be npwz:<profession>:<number>');
        end if;
        -- Only member accounts that hold a practice with this licence count (RD2-1): only those practices move, so an account
        -- the person was split out of (it keeps someone else's practice) no longer refuses.
        select coalesce(array_agg(distinct x.account_key), '{}'::text[]) into v_lic_keys
        from private.person_practices(v_members, v_src) x where x.npwz = v_lic;
        if exists (select 1 from crm.reg_entry e where e.account_key = any (v_lic_keys) group by e.account_key
                   having (bool_or(e.entity_type in (1, 3)) and bool_or(e.entity_type in (4, 5)))
                       or (bool_or((e.qflags & 524288) <> 0) and count(*) > 1
                           and not exists (select 1 from crm.val_proposal a where a.kind = 'account_check' and a.status in (1, 2)
                                             and e.account_key = any (a.members))))
           -- a practice of the same profession under another licence number counts only when its holder is somebody else by
           -- name: one person may hold two numbers of one register (doctor and dentist, nurse and midwife), and the split
           -- (private.minority_entries) uses the same name rule, so "split first" always has something to split (RD2-2)
           or exists (select 1 from private.person_practices(v_lic_keys, v_src) x
                      join crm.reg_entry xe on xe.id = x.id
                      where private.licence(x.npwz) <> v_lic
                        and not exists (select 1 from private.person_practices(v_lic_keys, v_src) h join crm.reg_entry he on he.id = h.id
                                        where h.npwz = v_lic and private.same_person(he.name, xe.name, true))) then
          perform private.raise_err('CR422', 'account_check_first',
            'a member account holds entries of other people or of a company: split that account first, then accept');
        end if;
        -- VAL-R4-1: the target is a member account that holds a practice with this licence; first one whose entries all belong
        -- to that person (their names nest with a holder's name: no other person's JDG, practice or company), then (VAL-R3-3)
        -- a valid-NIP account (n:), then the account with more entries, then the key
        with lic as (select x.id, x.account_key from private.person_practices(v_members, v_src) x where x.npwz = v_lic),
             holder as (select e.name from crm.reg_entry e where e.id in (select lic.id from lic)),
             -- practices of the profession under another valid licence number: nest-only against a holder (VAL-R6-1)
             other as (select x.id from private.person_practices(v_members, v_src) x where private.licence(x.npwz) is not null and private.licence(x.npwz) <> v_lic),
             cand as (select e.account_key as k, count(*) as n,
                             bool_and(exists (select 1 from holder h where private.same_person(h.name, e.name, e.id in (select other.id from other)))) as clean
                      from crm.reg_entry e where e.account_key in (select lic.account_key from lic) group by e.account_key)
        select cand.k into v_target from cand order by cand.clean desc, (cand.k like 'n:%') desc, cand.n desc, cand.k limit 1;
        if v_target is null then
          perform private.raise_err('CR422', 'invalid_payload', 'no practice with this licence number in the member accounts');
        end if;
        -- only the person's own practices move (those carrying the licence number), never whole accounts (VAL-R3-2)
        for v_entry in select x.id from private.person_practices(v_members, v_src) x where x.npwz = v_lic and x.account_key <> v_target loop
          v_keys := v_keys || private.account_link(v_entry, 'attach', v_target, 'potwierdzona ta sama osoba (' || left(p.match_value, 60) || ')', v_me);
        end loop;
        if cardinality(v_keys) = 0 then
          perform private.raise_err('CR422', 'invalid_payload', 'no practice with this licence number outside the target account');
        end if;
        perform private.recompute_accounts(v_keys);
      else
        for v_k in select unnest(v_members) loop
          select e.id into v_entry from crm.reg_entry e where e.account_key = v_k order by e.is_account_primary desc, e.id limit 1;
          if v_entry is not null then
            perform private.write_activity(v_entry, 'validation', v_me, 'Potwierdzono: to ten sam podmiot (' || p.kind || ' ' || left(p.match_value, 80) || ')');
          end if;
        end loop;
      end if;
    end if;
    update crm.val_proposal set status = 1, decided_members = v_members, new_members = '{}', decided_by = v_me,
      decided_at = now(), note = v_note, network_id = v_net where id = p_id returning * into p;

  elsif d = 'reject' then
    if p.kind = 'account_check' then
      -- a company/public body and practices share one NIP: detach the minority group (ties: detach the practices)
      for v_k in select unnest(p.members) loop
        v_keys := '{}';
        for v_entry in select unnest(private.minority_entries(v_k)) loop
          v_keys := v_keys || private.account_link(v_entry, 'detach', null, 'odrzucono propozycję: różne podmioty', v_me);
        end loop;
        if cardinality(v_keys) > 0 then perform private.recompute_accounts(v_keys); end if;
      end loop;
    else
      for v_k in select unnest(p.members) loop
        select e.id into v_entry from crm.reg_entry e where e.account_key = v_k order by e.is_account_primary desc, e.id limit 1;
        if v_entry is not null then
          perform private.write_activity(v_entry, 'validation', v_me, 'Odrzucono propozycję: ' || p.kind || ' ' || left(p.match_value, 80));
        end if;
      end loop;
    end if;
    update crm.val_proposal set status = 2, decided_members = members, new_members = '{}', decided_by = v_me,
      decided_at = now(), note = v_note where id = p_id returning * into p;

  elsif d = 'reopen' then
    update crm.val_proposal set status = 0, new_members = '{}', decided_members = null, decided_by = null, decided_at = null,
      note = null where id = p_id returning * into p;
  else
    perform private.raise_err('CR422', 'invalid_payload', 'decision must be accept|reject|reopen');
  end if;
  return private.proposal_json(p);
end $$;

create or replace function api.val_decisions() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_owner();
begin
  return jsonb_build_object(
    'detach', (select coalesce(jsonb_agg(private.hex16(key_hash) order by key_hash), '[]') from crm.val_decision where action = 'detach'),
    'attach', (select coalesce(jsonb_agg(jsonb_build_object('keyHash', private.hex16(key_hash), 'accountKey', account_key) order by key_hash), '[]')
               from crm.val_decision where action = 'attach'),
    'genericDomains', (select coalesce(jsonb_agg(jsonb_build_object('domain', domain, 'kind', kind, 'suggestion', suggestion) order by domain), '[]')
                       from crm.generic_domain),
    -- decided proposals (RD3-2): the import preview leaves out those that stay decided (no member beyond decided_members)
    'decidedProposals', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'matchValue', match_value, 'members', to_jsonb(decided_members))
                                                   order by id), '[]')
                         from crm.val_proposal where status in (1, 2)),
    'params', private.validation_params());
end $$;

-- Networks -------------------------------------------------------------------------------------------------------------
create or replace function private.network_json(n crm.network) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', n.id, 'name', n.name, 'note', n.note,
    'accounts', (select count(*) from crm.network_member m where m.network_id = n.id),
    'entries', (select count(*) from crm.network_member m join crm.reg_entry e on e.account_key = m.account_key where m.network_id = n.id),
    'createdAt', n.created_at)
$$;

create or replace function api.networks_list() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  return (select coalesce(jsonb_agg(private.network_json(n) order by lower(n.name)), '[]') from crm.network n);
end $$;

create or replace function api.network_upsert(p_network jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me smallint := private.require_member();
  n    crm.network;
  v_name text := private.patch_text(p_network, 'name', 200);
begin
  if v_name is null then perform private.raise_err('CR422', 'invalid_payload', 'name is required'); end if;
  begin
    if p_network ->> 'id' is not null then
      update crm.network set name = v_name, note = case when p_network ? 'note' then private.patch_text(p_network, 'note', 2000) else note end,
        updated_at = now() where id = (p_network ->> 'id')::int returning * into n;
      if not found then perform private.raise_err('CR404', 'not_found', 'network ' || (p_network ->> 'id')); end if;
    else
      insert into crm.network (name, note, created_by) values (v_name, private.patch_text(p_network, 'note', 2000), v_me) returning * into n;
    end if;
  exception when unique_violation then
    perform private.raise_err('CR409', 'duplicate_name', 'a network with this name exists');
  end;
  return private.network_json(n);
end $$;

create or replace function api.network_member_remove(p_network_id int, p_account_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me smallint := private.require_member();
begin
  delete from crm.network_member where network_id = p_network_id and account_key = p_account_key;
  if not found then perform private.raise_err('CR404', 'not_found', 'network member'); end if;
  return jsonb_build_object('removed', true);
end $$;

select private.apply_api_grants();
