# RPWZL CRM: data model

Postgres 17 on Supabase (Free plan, 500 MB database-size limit, project `ivrtdxyymdrykphanotk`, eu-central-1).
This document is the DB builder's specification. Names here, in [CONTRACT.md](CONTRACT.md) and in
`app/src/lib/contract.ts` must agree. Product rules live in [SPEC.md](SPEC.md).

## 1. Principles

1. **One writer per field.** Register columns (`reg_*` tables) are written only by the import RPCs. CRM data
   (`lead`, `activity`, `task`, …) is written only by user RPCs. A register refresh therefore cannot overwrite
   anything the team entered, by construction.
2. **Nothing is reachable from the browser except functions.** Tables live in schema `crm` (not exposed); helper
   functions in `private` (not exposed); the Data API exposes only schema `api`, which contains only functions.
   RLS is enabled on every table with no policies (deny-all) as a second wall.
3. **Fit in 500 MB for two years.** Every byte on the 264 k register rows is multiplied 264 000 times: compact
   types, facet values as `smallint[]` dictionary ids, detail packed 32 entries per row so TOAST compresses it,
   CRM rows only for leads someone touched, history as field-level diffs. Measured in section 9.
4. **No whole-table updates.** Derived values are computed by the import worker and inserted once; a refresh
   updates only rows whose hashes changed. A full-table `UPDATE` would leave a dead copy of the heap that the Free
   plan cannot shrink without `VACUUM FULL`.

## 2. Schemas, extensions, roles

| schema | content | exposed |
|---|---|---|
| `crm` | all tables | no |
| `private` | helpers: `require_member()`, `require_owner()`, `f_unaccent()`, filter compiler, hash/key helpers | no |
| `api` | `SECURITY DEFINER` RPCs, the only callable surface | yes (Data API "Exposed schemas" = `api` only) |

Extensions: `unaccent` (Supabase installs it in schema `extensions`). No `pg_trgm` (a trigram index on names
costs 17 MB; a sequential `unaccent` scan of 234 k names took 145 ms locally, see 9.4).

Grants (first migration):

```sql
revoke all on schema crm, private from public, anon, authenticated;
revoke all on all tables in schema crm from public, anon, authenticated;
alter default privileges in schema crm revoke all on tables from public, anon, authenticated;
grant usage on schema api to authenticated;            -- never to anon
alter default privileges in schema api revoke execute on functions from public, anon;
-- every api function: revoke execute ... from public, anon; grant execute ... to authenticated;
```

Every `api` function: `language plpgsql` or `sql`, `security definer`, `set search_path = ''` (all names
schema-qualified), owner `postgres`, first statement `perform private.require_member();` or
`perform private.require_owner();` (section 7). Functions that scan or write many rows add
`set statement_timeout = '50s'` (Supabase honours function-level timeouts for REST calls; the client cap is
60 s; the `authenticated` role default is 8 s).

## 3. Register tables (writer: import RPCs only)

### 3.1 `crm.reg_dict` — facet value dictionary

| column | type | notes |
|---|---|---|
| `id` | `smallint generated always as identity primary key` | ≤ 32 767 values (real data: 3 408 facet values + 33 registering bodies). Guarded (SEC-07): a row carries ≤ 2 000 facet values (RD-6: the largest real podmiot has 371), a batch of `import_entries` and a call of `import_labels` add ≤ 2 000 new values (real: ≤ 136 per 500-row batch, 783 labels), the dictionary section runs under a transaction advisory lock (SEC-12), the sequence is re-synchronised to `max(id)` before new values are inserted (ids burned by rolled-back calls are reclaimed) and an overflow is `CR422 dictionary_full`; `db_usage` reports `dictValues` / `dictLimit` |
| `facet` | `text not null` | `p.status`, `p.rodzaje`, `p.grp`, `p.spec`, `p.dz`, `p.fn`, `p.forma`, `p.formType`, `p.woj`, `r.src`, `r.grupaPraktyk`, `r.gz`, `r.typ`, `r.rodzaj`, `r.rd`, `r.spec`, `r.zakres`, `r.forma`, `r.organ`, `r.status`, `r.woj`, and `org` (registering body used in the register key) |
| `val` | `text not null` | value exactly as in the data (`'?'` allowed, e.g. unknown specialty group) |
| `label` | `text` | display label when it differs (specialty code → name from the index header `names`, group code → group name) |

`unique (facet, val)`. Values are never deleted (saved filters reference values, not ids).

### 3.2 `crm.reg_entry` — one row per register entry (podmiot or praktyka)

| column | type | notes |
|---|---|---|
| `id` | `int generated always as identity primary key` | internal; never exported as an identifier |
| `key_hash` | `bigint not null unique` | first 8 bytes of SHA-256(`reg_key`) as signed int64, computed by the worker; the stable identity across refreshes and database rebuilds |
| `kind` | `"char" not null` | `'p'` podmiot, `'r'` praktyka |
| `src` | `smallint not null` | index in `SOURCES` (0 Rpm … 8 Rpdlg) |
| `reg_org` | `smallint not null` | `reg_dict` id of facet `org` (registering body name) |
| `ks` | `text not null` | register book number (`d.ks`) |
| `kseq` | `smallint not null default 1` | tie-break for the 3 real book-number collisions (SPEC 5.2) |
| `name`, `nip` | `text` | as in the index (`nip` digits only) |
| `nip_status` | `smallint not null` | `NIP_STATUS` |
| `entity_type` | `smallint not null` | `ENTITY_TYPE` |
| `account_key` | `text not null` | `'n:<nip>'` or `'e:<key_hash hex>'` (SPEC 6.2) |
| `account_size` | `smallint not null default 1` | entries sharing `account_key` |
| `is_account_primary` | `boolean not null default true` | |
| `fv` | `smallint[] not null` | every categorical facet value id of the entry (scalars and arrays together) |
| `emails` | `text[]` | podmioty only (`emails[]` of the index); null for practices |
| `nums` | `int[]` | every parsed 9-digit phone number (`tel` first, then `phones[]`); a 9-digit number fits int4 |
| `email`, `tel`, `www` | `text` | primary register values, raw |
| `mobile`, `tel_norm` | `int` | 9-digit numbers or null; `mobile` skips a number used by ≥ 5 owners (`MOBILE_SHARED`, VAL-R3-6) |
| `tel_shared` | `int` | owners of `tel_norm` within the kind (offline tool V2.1.4) |
| `cflags` | `smallint not null` | `CFLAG` bits |
| `miasto`, `kod` | `text` | |
| `wpis`, `stan` | `date` | register entry date, last record change |
| `nz`, `nk`, `spec1` | `smallint`, `int`, `smallint` | p only (zakłady, komórki, distinct specialist clinics) |
| `q_email`, `q_phone` | `smallint` | 0–100 contact quality of the best value (SPEC 6.4) |
| `qflags` | `int not null default 0` | `QFLAG` bits |
| `in_register` | `boolean not null default true` | false once the entry disappeared from a full import |
| `first_run`, `last_change_run`, `gone_run` | `smallint` | `import_run.id`; `gone_run` null while present |
| `h_all`, `h_contact`, `h_derived` | `bigint not null` | hashes (CONTRACT 6.3) used for refresh diffs |

Default fillfactor (100): only changed rows are updated (≈ 2 % a month).

Indexes (sizes of the 9.2 prototype; after the real first import through the app all indexes of `reg_entry` together take
51–53 MB, see 9.3):

```sql
create unique index on crm.reg_entry (key_hash);                         -- 6 MB
create index on crm.reg_entry using gin (fv);                            -- 6 MB, all facet filters
create index on crm.reg_entry using gin (nums);                          -- 10 MB, phone search, phone owners
create index on crm.reg_entry using gin (emails);                        -- 3 MB, e-mail search
create index on crm.reg_entry (account_key);                             -- 10 MB measured, "same account"
```

The account index is complete, not partial (`where account_size > 1`, < 2 MB, was the original design): proposal and
network members are mostly single-entry accounts, and a partial index cannot serve `account_key = $1` for them (CONTRACT 8,
DB deviation 1). No index on `name`, `nip`, `miasto`, `wpis`: list queries are filtered sequential scans of an 80 MB heap
(9.4).

### 3.3 `crm.reg_detail_block` — record-card detail, 32 entries per row

| column | type | notes |
|---|---|---|
| `block_no` | `int primary key` | `entry_id >> 5` |
| `recs` | `text compression pglz not null` | JSON object `{"<entry_id>": RegisterRec, …}` |

`RegisterRec` = the index record minus the fields kept as `reg_entry` columns or facets, plus `d` parsed
(CONTRACT 6.2). Why blocks and why text: a podmiot or practice detail is ~1.1 KB (median); Postgres compresses
a value only when the whole row exceeds ~2 KB (`TOAST_TUPLE_THRESHOLD`; `toast_tuple_target = 128` did not
change that in our test), so per-entry rows are stored uncompressed (343 MB). Packing 32 entries makes rows of
~40 KB that pglz compresses ~4×; text compresses better than jsonb's binary form (measured: 80 MB text vs
128 MB jsonb). `lz4` measured the same size; `pglz` is chosen because it is always available.

Read: `select (recs::jsonb) -> p_id::text from crm.reg_detail_block where block_no = p_id >> 5` (0.8 ms).
Write: the import groups rows by block and runs one
`insert … on conflict (block_no) do update set recs = (crm.reg_detail_block.recs::jsonb || excluded.recs::jsonb)::text`
per block touched. New entries get increasing ids, so they fill new blocks.

### 3.4 `crm.import_run`

`id int identity pk`, `status text check (status in ('running','applied','failed','aborted'))`, `file_name text`,
`file_sha256 text`, `index_version smallint`, `hash_version smallint`, `index_created_at timestamptz`,
`tool_today date`, `report_date date` (oldest source report date), `sources jsonb`, `full_sources text[]` (sources
the file contains completely: only these can produce "gone"), `preview jsonb`, `counts jsonb`, `started_by smallint
→ team_member`, `started_at timestamptz default now()`, `finished_at timestamptz`, `error text`.
At most one row with `status = 'running'` (partial unique index); a `running` row older than 2 hours may be
aborted by the next `import_begin`.

### 3.5 `crm.reg_change` — compact register history

| column | type | notes |
|---|---|---|
| `run_id` | `smallint not null` | |
| `entry_id` | `int not null` | |
| `change` | `smallint not null` | 1 changed, 2 returned (re-appeared) |
| `fields` | `int not null` | bitmask of changed field groups (CONTRACT 6.5) |
| `old` | `jsonb` | old values of changed fields in groups `contact`, `name`, `address`, `status`; null otherwise |

`primary key (entry_id, run_id)`, `index (run_id, change)`. "New" and "gone" need no rows: they are
`reg_entry.first_run = run` and `gone_run = run`. Retention: rows of runs older than the 24 most recent are
deleted by `import_finish` (setting `history.keepRuns`, default 24). The detail `d` is not versioned (only its
hash), which is what keeps history small.

## 4. Validation tables (writer: import RPCs and validation RPCs)

### 4.1 `crm.val_proposal`

`id int identity pk`, `kind text check (kind in ('account_check','person','partner','email','domain','www','phone','reg_duplicate'))`,
`match_value text not null`, `confidence smallint not null`, `group_key text not null` (hash of the sorted member
set), `members text[] not null` (account keys, sorted), `decided_members text[]` (members at decision time),
`new_members text[] not null default '{}'`, `status smallint not null default 0` (`PROPOSAL_STATUS`),
`last_run smallint`, `decided_by smallint`, `decided_at timestamptz`, `note text`, `network_id int`.
`unique (kind, match_value)`, `index (status, kind)`, `gin (members)`.

### 4.2 `crm.val_decision`

Account-link overrides the worker must respect: `id int identity pk`, `action text check (action in ('detach','attach'))`,
`key_hash bigint not null unique` (the entry), `account_key text` (target for `attach`), `note text`, `decided_by`,
`decided_at`. A later decision for the same entry replaces the earlier one (the replaced row is kept in the
entry's timeline as an activity of type `validation`).

### 4.3 `crm.network`, `crm.network_member`

`network(id int identity pk, name text not null unique, note text, created_by, created_at)`;
`network_member(account_key text primary key, network_id int not null references network on delete cascade, added_by, added_at)`
— an account belongs to at most one network.

### 4.4 `crm.generic_domain`

`domain text primary key`, `kind text check (kind in ('free','generic','typo','social'))`, `suggestion text`
(for typos), `source text check (source in ('seed','auto','owner'))`, `updated_at`. Seeded by a migration with
the lists in SPEC 6.4 (public reference data, no personal data). `auto` rows are written by the import
(domains over the generic threshold); the owner can override any row.

## 5. CRM tables (writer: user RPCs)

All carry `created_at timestamptz not null default now()`; mutable ones also `updated_at`, `updated_by smallint`.
"member id" columns reference `crm.team_member(id)`.

| table | columns (besides the above) | keys / indexes |
|---|---|---|
| `team_member` | `id smallint identity`, `email text not null` (lower-case), `display_name text not null`, `role text check (role in ('owner','member'))`, `phone text`, `active boolean default true`, `user_id uuid unique` (filled on first sign-in), `last_seen_at timestamptz` | `unique (email)` |
| `app_setting` | `key text pk`, `value jsonb not null` | keys: `ui.staleDays`, `val.minConfidence`, `val.params`, `sms.diacritics`, `history.keepRuns`, `export.defaults` |
| `lead_status` | `id smallint identity`, `name text unique`, `color text`, `sort smallint`, `stage text check (stage in ('open','won','lost','paused'))`, `is_default boolean`, `active boolean` | exactly one `is_default` (partial unique index); seeded 1–9 (SPEC 7.2) |
| `tag` | `id smallint identity`, `name text unique`, `color text` | |
| `lead` | `entry_id int pk references reg_entry`, `status_id smallint not null references lead_status`, `owner_id smallint`, `tags smallint[] not null default '{}'`, `short_name text`, `dnc boolean not null default false`, `dnc_reason text`, `dnc_at timestamptz`, `dnc_by smallint`, `validation smallint` (null = derived), `validation_note text`, `checklist jsonb`, `validated_at timestamptz`, `validated_by smallint`, `next_step_at date`, `next_step_note text`, `last_contact_at timestamptz`, `version int not null default 1` | indexes `(owner_id)`, `(status_id)`, `(next_step_at) where next_step_at is not null`, `gin (tags)` |
| `lead_contact` | `id int identity`, `entry_id int not null`, `kind text check (kind in ('email','phone','www','person'))`, `value text`, `value_norm text`, `person_name text`, `person_role text`, `status text check (status in ('ok','invalid','unknown'))`, `is_primary boolean`, `source text check (source in ('crm','register'))`, `note text` | `(entry_id)`; one primary per (entry, kind) |
| `activity` | `id bigint identity`, `entry_id int not null`, `type text not null` (`ActivityType`), `outcome text`, `contact_value text`, `subject text`, `body text check (length(body) <= 5000)`, `status_from smallint`, `status_to smallint`, `template_id int`, `task_id bigint`, `occurred_at timestamptz not null`, `created_by smallint not null` | `(entry_id, occurred_at desc)`, `(created_by, occurred_at desc)` |
| `task` | `id bigint identity`, `entry_id int`, `title text not null`, `note text`, `due_date date not null`, `due_time time`, `assignee_id smallint not null`, `done_at timestamptz`, `done_by smallint`, `created_by smallint` | `(assignee_id, due_date) where done_at is null`, `(entry_id)` |
| `template` | `id int identity`, `kind text check (kind in ('email','sms','call'))`, `name text`, `subject text`, `body text check (length(body) <= 10000)`, `active boolean`, `sort smallint` | `unique (kind, name)` |
| `list` | `id int identity`, `name text unique`, `note text`, `created_by` | |
| `list_member` | `list_id int references list on delete cascade`, `entry_id int`, `added_by smallint`, `added_at timestamptz` | `pk (list_id, entry_id)`, `(entry_id)` |
| `saved_view` | `id int identity`, `name text`, `scope text check (scope in ('system','shared','private'))`, `owner_id smallint`, `filter jsonb not null`, `sort jsonb`, `columns text[]`, `note text`, `sort_order smallint` | `unique (scope, owner_id, name)`; system views seeded (SPEC 7.6) |
| `export_log` | `id int identity`, `format text`, `target jsonb`, `options jsonb`, `total int`, `created_by smallint` | rows exported are never stored |

A `lead` row is created by the first CRM write to an entry (`insert … on conflict do nothing`), never by the
import. "No lead row" means: default status, no owner, no tags, derived validation, not dnc, version 0.

Side-effect activities written by the server (not by `activity_add`): `status` (status change, with
`status_from`/`status_to`), `owner`, `validation`, `dnc`, `task` (task completed). Bulk actions write one activity
per affected lead. Register changes are not copied into `activity`; the timeline reads `reg_change`.

## 6. Facets and filters on 264 k rows

- All categorical facets of an entry are dictionary ids in one `smallint[]` column `fv` with one GIN index.
  Ids are unique across facets, so "OR within a facet, AND across facets" compiles to one `fv && $ids` predicate
  per facet with a selection. Values in filters are strings; `private.compile_filter(jsonb)` maps them to ids
  (unknown values match nothing).
- `p.fn` tree selection: a selected value matches every dictionary value of facet `p.fn` that starts with it
  (`val like sel || '%'`); a value ending with `=` matches exactly (offline tool resolved ambiguity 6).
- Numeric/date filters (`wpis`, `stan`, `spec1`, `nk`), contact flags (`cflags & mask = mask`), entity type, NIP
  status and `qflags` are plain columns on the same row.
- CRM filters join `crm.lead` with a `left join`; absence of a row means default values. `validation` filters the
  effective status: `coalesce(l.validation, case when e.qflags & PROBLEM_MASK <> 0 or e.account_key = any(open_members) then 1 else 0 end)`.
- Faceted counts (`api.leads_facets`): one pass `unnest(fv) … group by` under the full filter for facets without
  a selection, plus one pass per selected facet with that facet's own predicate removed. Locally: 199 ms per
  pass over all podmioty.
- Sorting uses Postgres top-N sort with `id` as the tie-breaker (`order by name collate "pl-PL-x-icu", id` if the
  ICU collation exists, else `"C"`); offset paging, limit ≤ 200.

## 7. Security model

- `private.require_member()` → `smallint` member id. Reads `auth.uid()` and `auth.jwt() ->> 'email'`; finds the
  active `team_member` row by `user_id`, or on first sign-in by lower-case e-mail (then stores `user_id`); raises
  `CR401` without a JWT and `CR402` when no active row exists. Updates `last_seen_at` at most once per 10 minutes.
- `private.require_owner()` = `require_member()` plus `role = 'owner'`, else `CR403`.
- Sign-ups are disabled; the owner creates the auth users in the dashboard. An auth user whose e-mail is not on
  the allowlist can sign in to Supabase Auth but every RPC refuses it (`CR402`); the app shows the Polish message.
- Owner-only RPCs: everything not in `MEMBER_RPCS` (contract.ts): imports, exports, backup/restore, members,
  settings, statuses, tag deletion, generic domains, `db_usage`. Rules inside member RPCs: only the owner clears
  `dnc`; a member edits or deletes only own activities within 24 h; lists and private views are edited by their
  creator or the owner.
- RLS on every `crm` table, no policies. `anon` has no grants anywhere. Tests in `supabase/tests/` prove:
  anon cannot call any `api` function; an authenticated non-member gets `CR402`; a member gets `CR403` on every
  owner-only RPC; no `crm` table is readable with the publishable key.

## 8. Concurrency, integrity, maintenance

- `lead.version` is checked by `lead_update` (`CR409` on mismatch) and incremented by every write to the row.
- Import RPCs require the caller to be the owner who started the `running` run.
- `reg_entry` and `reg_detail_block` rows are never deleted (gone entries keep their CRM history).
- After an import, `import_finish` runs `analyze crm.reg_entry` (not `vacuum`, which cannot run inside a function);
  autovacuum reclaims dead tuples for reuse.
- Free-plan space meter: `api.db_usage()` returns `pg_database_size(current_database())` and the largest `crm`
  tables; the app warns at 400 MB and blocks a new import above 450 MB (SPEC 9.3).

## 9. Size budget (measured 2026-11-15 on the real register)

### 9.1 Method

Throwaway container `postgres:17` (17.12) on port 55432 (`crm-size-test`, removed afterwards). Data: no v2 index
existed yet, so one was built from the raw RPWDL JSON with the offline tool's own extraction code (`extractP`,
`extractR`, `ObjScanner` copied read-only from its `src/03-core.js`): 264 050 records (29 843 podmioty,
234 207 praktyki), 59.5 MB gzipped, same counts as the tool's spec (34 702 active zakłady). Records were loaded
with `COPY`, then `VACUUM ANALYZE`, sizes from `pg_total_relation_size`. CRM tables were filled with synthetic
rows (no real data) at two-year volumes. Scripts and the converted index stay in `/tmp/claude-work/crm-work/architect/`
(contain personal data; not in the repo).

### 9.2 Iterations

| variant | result |
|---|---|
| naive: per-entry `jsonb` detail, text `reg_key` unique, separate contact table (518 k rows), a `lead` row per entry | **567 MB** database: over the limit |
| detail per entry, `jsonb` lz4 or pglz, `toast_tuple_target = 128` | 361 MB (no compression: rows < 2 KB) |
| detail per entry as `text` | 322–325 MB |
| detail in blocks of 32, `jsonb` lz4 / pglz | 128 MB |
| detail in blocks of 32, `text` pglz / lz4 (full record) | 88 / 92 MB |
| blocks of 32, `text`, record without fields duplicated in columns (**chosen**) | **80 MB** (lz4 80, 64 per block 75) |
| `reg_entry` with text key, trigram name index, (kind,name) and nip btrees | 160 MB |
| `reg_entry` with `key_hash`, contacts as `emails[]`/`nums int[]`, 5 indexes (**chosen**) | **107.5 MB** (heap 72, indexes 35) |

### 9.3 Result and two-year projection

**Measured after the real first import through the app (2026-11-15, round-1 verifier RDV-3, fresh local stack):**
`pg_database_size` 229 MB (233 MB after four import runs and some CRM work), schema `crm` 215 MB: `reg_entry` 133 MB
(heap 80, indexes 51; `pgstattuple`: 0 dead tuples, 1.4 % free space, so this is real size, not bloat; the complete account
index alone is 10 MB), `reg_detail_block` 81 MB. Register total **215 MB**, against 187.6 MB of the prototype below (its
`reg_entry` had fewer columns and the partial account index). The local figure includes the local stack's own schemas
(≈ 14 MB) but not a hosted project's 40–60 MB.

**Re-measured by the round-2 verifier (RD2-3, own fresh stack, same file):** after the first import `pg_database_size`
236 MB, schema `crm` 217 MB: `reg_entry` 133 MB (heap 80, indexes 53), `reg_detail_block` 81 MB (79 MB of it TOAST),
`val_proposal` 2.1 MB. After 3 imports, 13 decisions, 3 lead edits and 4 exports: 239 MB, `crm` 220 MB (Settings shows
„Zajęte 239 MB z 500 MB”). `val_proposal` grows to about twice its size (2.1 → 4.4 MB) because every import rewrites
`last_run` on each proposal (about 3 000 row versions on a no-change import); autovacuum reuses that space, so it levels
off at a few MB. Not optimised (moving `last_run` to `import_run` would change how stale proposals are found; the gain is
about 2 MB). The figures below use the higher measurement (register 217 MB) and give a range.

Prototype measurement (9.1, kept for the method):

| table | measured MB | basis |
|---|---|---|
| `reg_entry` | 107.5 | real, 264 050 rows |
| `reg_detail_block` | 79.4 | real |
| `reg_dict` | 0.7 | real |
| **register total (day one)** | **187.6** | |
| `activity` | 37.0 | synthetic 120 000 rows (3 users × ~80 actions/working day × 2 years), bodies ~90 chars |
| `reg_change` | 14.9 | synthetic 144 000 rows (24 refreshes × 6 000 changed entries; 25 % with old contact values) |
| `lead` | 7.3 | synthetic 30 000 touched leads with checklist |
| `task` | 6.8 | synthetic 40 000 |
| `list_member` | 4.9 | synthetic 60 000 |
| `val_proposal` | 0.8 | synthetic 6 000 |
| **measured `crm` total** | **259.3** | |

Projection after two years, same method with the measured register: register grows with new entries (last 12 months:
14 461 practices + 1 942 podmioty ≈ 16 400 a year ⇒ +12.4 % in two years) 215–217 → 242–244 MB; CRM 72 MB; dead-tuple
margin 20 MB; Supabase's own objects in a new project 40–60 MB (Supabase docs) → **374–396 MB of 500 MB** (was 343–363 MB
with the prototype's register). The upper end is above the SPEC 9.3 target of 380 MB and just under the 400 MB warning,
below the 450 MB import block and the 500 MB limit. Day one: 215–217 MB + 40–60 MB = **255–277 MB**. The owner decides whether to accept this
or to pull a lever now (CONTRACT 8 item 70); none is applied by default.
Register change rate used: ~2 000 records/month carry a new `dataZmiany` and ~3 000 a new `stanNaDzien`; 6 000
changed entries per refresh is a conservative round-up.

Headroom levers if the meter climbs (in order): keep 12 refreshes of history instead of 24 (−7 MB, a setting in
Ustawienia), make the account index partial again (−8 MB; member look-ups of single-entry accounts become sequential
scans), drop the `emails` GIN index (−3 MB, e-mail search becomes a scan), drop the `nums` GIN index (−10 MB, phone
search and phone owners become scans), archive activities older than 18 months into the backup file and delete them.
The first two together bring the projection to 359–379 MB.

### 9.4 Query timings (local container, 4 vCPU; Supabase Free "Nano" compute is shared and slower, not measured)

| query | ms |
|---|---|
| count POZ segment (3 facet predicates, GIN) → 8 167 rows (matches the offline tool) | 10.7 |
| page 3 of POZ sorted by name, with `lead` join | 7.6 |
| facet counts, all facets, active ambulatory podmioty | 198.8 |
| name contains (unaccent, sequential) over 234 k practices | 145.5 |
| practices with mobile and status Nowy (left join) | 35.0 |
| practices sorted by name, offset 5 000 | 29.2 |
| card detail read from a block | 0.8 |
