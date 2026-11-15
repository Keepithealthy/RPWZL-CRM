# RPWZL CRM: contract between the database and the app

Machine-readable twin: [`app/src/lib/contract.ts`](../app/src/lib/contract.ts) (types, codes, the `Rpc` map).
Tables and types: [DATA_MODEL.md](DATA_MODEL.md). Product rules: [SPEC.md](SPEC.md).
A change to any name or shape here is made in this file and in `contract.ts` in the same commit.

## 1. Directory ownership (three parallel builders)

| builder | owns (may create/edit) | reads, never edits |
|---|---|---|
| **DB** | `supabase/**` (config, migrations, `tests/*.sql` pgTAP, `seed.sql` synthetic) | `docs/*`, `contract.ts` |
| **APP** | `app/src/**` except the two feature folders below and `app/src/workers/**`; also `app/e2e/**`, `app/index.html`, `app/public/**` | `contract.ts`, `features/validation/rules.ts` |
| **IMPORT + VALIDATION** | `app/src/features/import/**`, `app/src/features/validation/**`, `app/src/workers/**` | `contract.ts`, `app/src/lib/supabase.ts`, `app/src/lib/api.ts` |
| architect (this document's author) | `docs/SPEC.md`, `docs/DATA_MODEL.md`, `docs/CONTRACT.md`, `docs/OPERATIONS.md` (builders send text changes for their screens), `app/src/lib/contract.ts`, root files (`README.md`, `CLAUDE.md`, `.gitignore`), `app/package.json`, `app/package-lock.json`, `app/*.config.*`, `app/tsconfig.json`, `supabase/config.toml` (shared with DB) | |

Rules for builders:

- Need a dependency, a config change or a contract change? Write it down as a request in your final report
  (exact diff); do not edit files outside your area. The APP and IMPORT builders must not run `npm install <pkg>`.
- Interfaces between the two app builders:
  - `app/src/lib/api.ts` (APP): typed wrapper `rpc<N extends RpcName>(name: N, args: RpcArgs<N>): Promise<RpcResult<N>>`
    that throws `CrmError { code: ErrorCode | 'NETWORK' | 'UNKNOWN'; messagePl: string; detail?: string }`.
    Until it exists, IMPORT code calls `supabase.rpc` directly through a local adapter in `features/import/`.
  - `app/src/features/validation/rules.ts` (IMPORT+VALIDATION): pure functions shared with the app —
    `parsePhone`, `phoneClass`, `normalizeEmail`, `emailQuality`, `phoneQuality`, `normalizeWww`, `wwwQuality`,
    `nipStatus`, `entityType`, `formTypeOf`, `spec1Count`, `nipKey`, `cleanName` (SPEC 6). The card (APP) imports
    them to label contacts; it never reimplements them.
  - Routes and screens: the import screen component is `features/import/ImportScreen.tsx` (default export) and
    the validation screen `features/validation/ValidationScreen.tsx`; APP mounts them at `/import` and `/walidacja`
    and supplies navigation, layout and the session (`useMe()` hook from `app/src/features/auth/`).
  - The worker is `app/src/workers/import.worker.ts`, created with
    `new Worker(new URL('../../workers/import.worker.ts', import.meta.url), { type: 'module' })`.
- Synthetic test data only. Shared fixture generator: `app/src/features/import/fixtures.ts` (IMPORT builder)
  produces a small v2 index (`rpwdl-lead-index`) from fake records; the DB seed uses the same fake names style.

## 2. Transport conventions

- Client: `createClient(VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, { db: { schema: 'api' } })`;
  calls: `supabase.rpc('<name>', { p_…: … })`. Only the publishable key is ever in the client.
- Every RPC returns one `jsonb` value (object or array), never `setof`, so PostgREST's `max_rows` (1000) never
  truncates results; lists are paged with `p_offset` / `p_limit`.
- Keys in returned JSON are camelCase as typed in `contract.ts`; arguments are `p_` snake_case.
- Dates `YYYY-MM-DD`; timestamps ISO 8601 with offset; int64 hashes as decimal strings; `key_hash` in
  hexadecimal (16 lower-case hex digits of the unsigned value) wherever it is shown or exchanged as a key.
- Errors: `raise exception using errcode = 'CR4xx', message = '<snake_case key>', detail = '<English detail>'`.
  Codes: `CR401` not signed in, `CR402` not on allowlist / inactive, `CR403` role or rule, `CR404` not found,
  `CR409` version conflict or duplicate name, `CR413` too many rows, `CR422` invalid payload (detail names the
  field), `CR423` import locked, `CR424` last owner. Any other code is shown as a generic error with the detail
  logged to the console (never to a remote service).

## 3. Session and reference data

| RPC | role | args | returns | notes |
|---|---|---|---|---|
| `me` | member | – | `Me` | first call after sign-in; links `team_member.user_id`; `CR402` → app signs out and shows the message |
| `ref_data` | member | – | `RefData` | statuses, tags, members, views, lists, last import, public settings; cached by the app (stale 5 min) |
| `dict` | member | `p_facets text[]` | `DictEntry[]` | all values (+ labels) of the requested facets |
| `db_usage` | owner | – | `DbUsage` | `pg_database_size` and the 10 largest tables |

## 4. Leads

| RPC | role | args | returns | limits / errors |
|---|---|---|---|---|
| `leads_search` | member | `p_filter`, `p_sort` (null = name asc), `p_offset ≥ 0`, `p_limit 1..200` | `{rows: LeadRow[]}` | `CR413` if limit > 200 |
| `leads_count` | member | `p_filter` | `LeadsSummary` | counts with e-mail/tel/www/nip/mobile in the selection |
| `leads_facets` | member | `p_filter`, `p_facets` | `FacetCounts` | each facet's counts ignore that facet's own selection; values with count 0 omitted |
| `lead_get` | member | `p_entry_id` | `LeadCard` | `CR404` |
| `lead_timeline` | member | `p_entry_id`, `p_scope` (`entry` or `account`), `p_before` (cursor, null = now), `p_limit ≤ 100` | `TimelineItem[]` newest first | merges `activity`, `reg_change` (+ synthetic items for first import and gone) and done tasks |
| `lead_update` | member | `p_entry_id`, `p_version` (0 if no lead row), `p_patch: LeadPatch` | `LeadRow` | `CR409` on version mismatch; `CR403` when a member sets `dnc=false`; writes side-effect activities |
| `leads_bulk` | member | `p_target: BulkTarget`, `p_action: BulkAction` | `{affected}` | `CR413` above `BULK_MAX` (20 000) or `entryIds` > 5 000; `set_dnc false` owner-only |
| `activity_add` | member | `p_entry_id`, `p_activity: ActivityInput` | `{activityId, row}` | one transaction: activity + optional status / next step / dnc / task; sets `lead.last_contact_at` for call/sms/email/meeting |
| `activity_update`, `activity_delete` | member | `p_id`, patch | `TimelineItem` / `{deleted}` | own and < 24 h old, or owner; only user types |
| `contact_upsert`, `contact_delete` | member | `p_entry_id`, `p_contact` / `p_id` | `LeadContact` / `{deleted}` | `source='register'` rows store a status/note override for a register value |

`LeadRow` field sources: `email` = CRM primary e-mail (`lead_contact` kind email, primary, status ≠ invalid)
else register `email` unless a `register` override marks it invalid; `tel` likewise for phones; `woj` from facet
`p.woj` / `r.woj`; `statusId` = lead status or the default status; `version` = lead version or 0;
`validation`/`validationIsDerived` per DATA_MODEL 6; `networkId` from `network_member` by `account_key`.

`LeadFilter` semantics: SPEC 4.2 and DATA_MODEL 6. `wpisRel` counts months back from the `report_date` of the
latest applied import (the offline tool's `addMonths`, day clamped). `q` matches `f_unaccent(lower(name))`
contains, or NIP contains (digits of `q`), or any e-mail contains, or — when `q` has ≥ 9 digits — the last 9
digits are in `nums`.

## 5. Tasks, templates, lists, views, validation, admin

| RPC | role | notes |
|---|---|---|
| `tasks_list` | member | `p_scope` mine/all, `p_open`, `p_due_to` (≤ date), `p_entry_id`, paging ≤ 200 |
| `task_upsert`, `task_done`, `task_delete` | member | assignee defaults to the caller; any member may edit any task |
| `today` | member | `TodayData` for the caller (SPEC 4.5) |
| `templates_list`, `template_upsert`, `template_delete` | member | `CR409` on duplicate (kind, name) |
| `lists_list`, `list_upsert`, `list_delete` | member | delete: creator or owner; members added via `leads_bulk` |
| `views_list`, `view_upsert`, `view_delete` | member | `system` scope: owner only; `private`: creator only |
| `val_summary` | member | `p_filter` restricts counts to proposals touching entries of the filter |
| `val_queue` | member | `p_queue` = `accounts` (kinds `account_check`, `person`, `reg_duplicate`) or `networks` (`email`, `domain`, `www`, `phone`, `partner`); `records` → `CR422` (the records queue is `leads_search` with `validation: [1]`); sorted by confidence desc, member count desc; hides confidence < `val.minConfidence` |
| `val_proposal_get` | member | entries of all member accounts (max 100); an open `account_check` also has `detachIds` (entries a reject detaches) |
| `val_decide` | member | accept: networks queue → adds member accounts to `networkId` or a new network `newNetworkName` (default name = first member's name); accounts queue → marks confirmed. reject: keeps members out. Writes a `validation` activity on each member's primary entry |
| `val_account_link` | member | `detach`: entry gets `account_key = 'e:<hex>'`; `attach`: entry joins `p_account_key`; stores `val_decision`; recomputes `account_size`/`is_account_primary` for the affected accounts only |
| `val_decisions` | owner | read by the import worker before computing accounts and proposals |
| `networks_list`, `network_upsert`, `network_member_remove` | member | |
| `members_list`, `member_upsert` | owner | `CR424` when the last active owner would be demoted/deactivated |
| `settings_get`, `setting_set` | owner | keys in DATA_MODEL 5 (`app_setting`); `CR422` on wrong type |
| `status_upsert`, `status_delete` | owner | delete requires `p_reassign_to`; leads move, activities keep history |
| `tag_upsert` | member | create/rename; `tag_delete` owner |
| `generic_domain_upsert` | owner | `p_kind` null deletes an owner/auto row |

## 6. Import

### 6.1 Sequence (worker ↔ database)

```
UI: owner picks rpwdl-index-*.json.gz  →  worker parses (stream, DecompressionStream('gzip')), validates header
1. val_decisions()                              → detach/attach overrides, generic domains, decided proposals, params
2. import_state(after_id, 20000) …until null    → id, keyHash, hAll, hContact, hDerived, inRegister, src per entry
3. worker: builds rows, derived fields, hashes, accounts, proposals; computes the preview (ImportCounts)
   UI shows the preview ("Co się zmieni") and waits for "Zatwierdź import"
4. import_begin(meta)                            → runId (CR423 if another run is active)
5. import_labels(runId, labels)                  → specialty/function/group labels from the index header + app constants
6. import_entries(runId, ≤500 rows) …            new, changed and returned entries (full rows)
7. import_derived(runId, ≤2000 rows) …           unchanged entries whose derived fields changed
8. import_gone(runId, ≤5000 key hashes) …        entries of fully contained sources absent from the file
9. import_proposals(runId, ≤1000 rows, final)    last call with p_final = true
10. import_finish(runId, counts)                 → run applied; prunes history; analyze
on any error: import_abort(runId, reason); calls 6–9 are idempotent (safe to retry the same batch)
```

Batch sizes adapt: if a call takes > 5 s the worker halves the batch for the next call; a failed call is retried
twice with back-off before aborting. The UI shows progress per phase and never blocks the main thread.

### 6.2 Mapping one index record (format `rpwdl-lead-index` version 2) to `ImportEntryRow`

The index record is first normalised with the same whitelist as the offline tool's `fixIndexRecord`; the detail
string `d` is parsed with `JSON.parse` (invalid or > 4 000 000 chars ⇒ record rejected, counted in `rejected`).
**Version 1 index files are refused** (`Ten plik indeksu jest w wersji 1 — zapisz indeks ponownie nowszą wersją
narzędzia (v2)`), because they carry no book number, which is the identity.

| `ImportEntryRow` | source |
|---|---|
| `kind`, `src` | `k`, `src` |
| `org` | p: `d.org`; r: `organ`; `''` if null |
| `ks` | `d.ks` (missing ⇒ record rejected) |
| `kseq` | 1, or the position (1-based) within records sharing `(src, org, ks)` ordered by `wpis` (null last), `name`, `nip`, file order |
| `regKey` | `` `${src}|${org}|${ks}|${kseq}` `` |
| `keyHash` | hex of the first 8 bytes of SHA-256(UTF-8 `regKey`) |
| `name`, `nip`, `email`, `tel`, `www`, `miasto`, `kod`, `wpis`, `stan` | same keys |
| `emails` | p: `emails`; r: `[]` |
| `nz`, `nk` | p: same keys; r: null |
| `facets` | p: `p.status`=[status], `p.rodzaje`, `p.grp`, `p.spec`, `p.dz`, `p.fn`, `p.forma`=[forma], `p.formType`=[formTypeOf(forma)], `p.woj`=[woj]; r: `r.src`=[src], `r.grupaPraktyk`, `r.gz`, `r.typ`, `r.rodzaj`, `r.rd`, `r.spec`, `r.zakres`, `r.forma`, `r.organ`, `r.status`, `r.woj` (scalars as one-element arrays; nulls omitted) |
| `rec` | p: `{emails, phones, ulica, rodzaje, dz, fn, d}`; r: `{phones, ulica, rodzaj, rd, d}` — arrays kept in index order because `d` refers to them by position |
| `derived` | SPEC 6 (`DerivedFields`); `nums`, `mobile`, `telNorm` as the offline tool V2.1.3 |

Server side, `import_entries` maps facet strings to `reg_dict` ids (inserting new values), `org` to a `reg_dict`
id of facet `org`, upserts `reg_entry` by `key_hash`, writes `rec` into the detail block, and writes
`reg_change` for updated rows (6.5). It rejects a row (`CR422`, detail = keyHash and field) when `kind`/`src`
disagree, `ks` is empty, a hash is not an int64, `regKey` is missing or differs from
`src|org|ks|kseq` built from the row's own fields (or its hash is not `keyHash`), a string exceeds its cap (name 1 000,
org / ks / any facet value 300, e-mail / tel / www / miasto / kod / nip 500, at most 50 `emails` of 500), a `keyHash` appears
twice in one batch, or `derived.accountKey` is not `n:<10 digits>` / `e:<16 hex>` or contradicts a stored attach / detach
decision (`import_entries` and `import_derived` both check; a decision made while an import runs makes it fail with a
message to start it again), or `rec` exceeds 1 MB. `first_run` = run for inserts; `in_register` = true and `gone_run` = null for returned entries.

### 6.3 Hashes (`HASH_VERSION` = 1)

`h(x)` = first 8 bytes of SHA-256 over the UTF-8 of `JSON.stringify(x)`, read as a big-endian signed int64,
sent as a decimal string.

- `hAll` = h([1, regKey, the normalised index record with keys in `fixIndexRecord` order, `d` as the original string])
- `hContact` = h([1, email, emails, tel, phones, www])
- `hDerived` = h([1, derived fields in `DerivedFields` key order])

Classification against `import_state`: key absent ⇒ new; present with `inRegister = false` ⇒ returned (send
full row); `hAll` differs ⇒ changed (and `changedContact` if `hContact` differs); only `hDerived` differs ⇒
derived-only; equal ⇒ unchanged (nothing sent). A run with a different `hashVersion` than the stored one sends
every entry as changed but records `reg_change` only where register fields really differ.

### 6.4 Gone and partial files

Only sources whose `sources[].records > 0` are present in the file can produce gone entries; an entry of such a
source missing from the file is sent to `import_gone`. Sources absent from the file leave their entries
untouched. The preview warns when more than 10 % of a source would be gone or when the file's report date is
older than the latest applied run (the owner must tick a confirmation).

### 6.5 `reg_change.fields` bits and `old`

| bit | group | fields compared | `old` stores |
|---|---|---|---|
| 0 | contact | email, emails, tel, phones, www | yes (old values) |
| 1 | name | name | yes |
| 2 | nip | nip | yes |
| 3 | address | miasto, kod, ulica, woj | yes |
| 4 | status | status | yes |
| 5 | legal | forma, typ, grupaPraktyk, organ | no |
| 6 | structure | rodzaje, grp, spec, dz, fn, nz, nk, spec1 / gz, rodzaj, rd, spec, zakres | no |
| 7 | dates | wpis, stan | no |
| 8 | detail | anything else inside `d` | no |

### 6.6 Proposals

`import_proposals` upserts by `(kind, matchValue)`: open rows get the new members/confidence; decided rows keep
their status, and `new_members` = incoming members not in `decided_members` (non-empty ⇒ status back to open,
the previous decision stays visible). With `p_final`, open proposals of kinds produced by this run that were not
sent are set to stale (3). Decided proposals are never deleted.

## 7. Export and backup (owner)

| RPC | args | returns | notes |
|---|---|---|---|
| `export_begin` | `p_target`, `p_format`, `p_options` | `{exportId, total}` | stores the target in `export_log`; dnc leads excluded unless `includeDnc` |
| `export_page` | `p_export_id`, `p_offset`, `p_limit ≤ 5000` | `ExportRow[]` | ordered by id; the app builds the file (SPEC 8); `inRegister` tells whether the entry is still in the register (Customer.io `in_register`) |
| `backup_export` | `p_table` (`BACKUP_TABLES`), paging ≤ 5000 | rows | entry references as `regKey`; members as e-mail; never register data |
| `backup_restore` | `p_table`, `p_rows` | `{inserted, skipped, unresolved}` | merge mode: inserts rows whose natural key is absent; `unresolved` = rows whose `regKey` has no entry (import the register first) |

Restore order: `team_member`, `lead_status`, `tag`, `app_setting`, `generic_domain`, `template`, `network`,
`network_member`, `list`, `saved_view`, `lead`, `lead_contact`, `list_member`, `task`, `activity`,
`val_decision`, `val_proposal`.

## 8. Deviations

Recorded by the APP builder. Each item is either a deliberate gap to close later or an assumption about the contract.

1. **Local phone helpers until `features/validation/rules.ts` exists.** `app/src/lib/links.ts` has `nationalNumber` (raw string ->
   9 digits), `isMobileNine` (Polish mobile prefixes 45, 50, 51, 53, 57, 60, 66, 69, 72, 73, 78, 79, 88) and `stripPolish`;
   `app/src/lib/template.ts` has `tidyName` (trim + collapse spaces) in place of `cleanName`. They only build `tel:`/`sms:` links and
   template values; all quality labels come from the database (`qflags`, `qEmail`, `phoneOwners`). When `rules.ts` lands,
   `nationalNumber` / `isMobileNine` / `tidyName` should delegate to `parsePhone` / `phoneClass` / `cleanName`.
2. **`tasks_list.p_open`** is read as `true` = open tasks only, `false` = done tasks only (tabs "Moje otwarte", "Wszystkie
   otwarte", "Zrobione"). The DB builder must implement the same meaning.
3. **Import and Validation screens** are resolved with `import.meta.glob('./features/import/ImportScreen.tsx')` (same for
   `ValidationScreen.tsx`) in `App.tsx`; while a file is missing the route shows a "not available yet" placeholder, once it exists
   it is lazy-loaded with no change in `App.tsx`.
4. **`history.keepRuns` and the generic-domain list.** `settings_get` returns only `PublicSettings` and `ValidationParams`, so the
   Settings screen cannot show the current "keep N imports" value (it shows the default 24 and writes on Save). Request: add
   `historyKeepRuns: number` to `settings_get`. The generic-domain table is read from `val_decisions().genericDomains` (owner-only).
5. **Database-size warning for members is not possible**: `db_usage` is owner-only, so the 400 MB banner is shown to the owner
   only (SPEC 9.3 says "everyone"). Request: expose the byte count to members, e.g. as `RefData.dbBytes`.
6. **Extra route `/eksport`** (owner): export a view / list / all leads plus the backup panel; the backup panel is also in Ustawienia.
7. **Export dialog counts** are shown after "Przygotuj plik" (rows in the file, skipped: nie kontaktować / brak e-maila /
   duplikaty), not live while the options change. "Nie kontaktować" skipped rows are counted with `leads_count({dnc: 'only'})`.
8. **Tests.** Vitest globals are off, so component tests import `src/test/autocleanup.ts`. Request: add
   `setupFiles: ['src/test/autocleanup.ts']` to `vite.config.ts` and drop those imports.
   `app/e2e/mocked.spec.ts` runs the SPA against a browser-side mock of Auth and the RPCs; it needs a build with placeholder values:
   `VITE_SUPABASE_URL=http://127.0.0.1:54399 VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_placeholder npm run build`
   (the test skips itself when the build has no Supabase configuration). It records `tel:` links instead of following them,
   because headless Chrome stops reacting to the page after a real `tel:` navigation.

## 8. Deviations (DB builder, 2026-11-15)

Everything below is implemented in `supabase/migrations/*.sql`; each item needs the architect's decision to become part
of the contract (`contract.ts` changes marked "contract.ts").

1. **Index `reg_entry_account` is complete, not partial** (DATA_MODEL 3.2 said `where account_size > 1`). Proposal and
   network members are mostly single-entry accounts, and a partial index cannot serve `account_key = $1` for them (a
   sequential scan of 264 k rows per member). Measured on 264 050 synthetic rows: 8.2 MB instead of < 2 MB (about +6 MB).
2. **`nextStep: 'due'`** (next step today or overdue, i.e. `next_step_at <= today`) is accepted by `LeadFilter` and used by
   the system view "Do kontaktu dziś" (SPEC 7.6 asks for "today or overdue", `NextStepFilter` has no such value).
   contract.ts: add `'due'` to `NextStepFilter`.
3. **Extra RPC `api.import_crm_work(p_key_hashes: string[]) → string[]`** (owner, ≤ 5 000 hashes): returns the key hashes of
   entries that carry CRM work (non-default status, owner, next step, last contact, tags, dnc, validation, any activity,
   task, CRM contact or list membership). The import preview (SPEC 4.10, "Te zmiany dotyczą leadów, nad którymi
   pracujecie") cannot be built from `import_state` alone. contract.ts: add to `Rpc`.
4. **Names of changed register fields.** `TimelineItem.fields`, `ImportChangeRow.fields` and
   `TodayData.registerChanges[].fields` carry the *group keys* of CONTRACT 6.5, in bit order: `contact`, `name`, `nip`,
   `address`, `status`, `legal`, `structure`, `dates`, `detail`. The app maps them to Polish labels. `reg_change.old` keys:
   contact `{email, emails, tel, phones, www}`, name `{name}`, nip `{nip}`, address `{miasto, kod, ulica, woj: string[]}`,
   status `{status: string[]}`; the bit `fields` is the mask of 6.5 (1, 2, 4, … 256).
5. **Status "delete" is a soft delete.** `status_delete` moves the leads to `p_reassign_to`, writes a `status` activity per
   moved lead and sets `active = false`; the row stays so `status_from` / `status_to` of old activities still resolve a
   name. `lead_status.name` is unique among active statuses only. `ref_data.statuses` therefore contains inactive rows.
6. **Return value `affected` of `leads_bulk`** is the number of leads actually changed (or added to / removed from a list),
   not the number targeted. Repeating an action returns 0.
7. **Version after the first write.** `lead_update` / `activity_add` create the lead row (version 1) and then increment it,
   so the first call with `p_version = 0` returns `version = 2`. Any later call must send the version it last saw.
8. **`q` free text:** the NIP-contains clause is used only when `q` has no letters and at least 3 digits; the phone clause
   needs at least 9 digits and no letters (otherwise "Lekarz 24" would match every NIP containing 24).
9. **`spec1Min` and `nkMin` with `kind: 'all'`** restrict only podmioty (rows of kind `r` pass), like the facets.
10. **`val_decide` side effects.** accept on the networks queue moves accounts that already belong to another network into the
    chosen one; accept on a `person` proposal merges the member accounts (an `attach` decision for every entry of the other
    accounts, recomputing sizes), other accounts-queue kinds only confirm; reject of an `account_check` detaches the
    minority group (companies/public bodies 1, 3 versus practices 4, 5; a tie detaches the practices) and stores `detach`
    decisions; every decision writes a `validation` activity on the primary entry of each member account.
    `val_account_link` / `val_decide` leave `reg_entry.h_derived` untouched, so the next import rewrites those entries'
    derived fields once (derived-only rows), which is harmless.
11. **`generic` rows of `generic_domain` match the domain and every sub-domain** (`gov.pl` covers `sanepid.gov.pl`); the
    import worker must implement the same suffix rule (`private.domain_class` does). `generic_domain_upsert` with
    `p_kind = null` deletes any row, including seeded ones.
12. **Timeline.** Activities of type `task` (written when a task is completed) are not returned as activity items; done
    tasks appear once, as `t:<task id>` items. Ties on `at` are ordered newest activity first.
13. **`export_begin`** normalises the target to a filter (an `entryIds` target also gets `inRegister: 'all'`), forces
    `dnc: 'exclude'` unless `includeDnc`, stores it in `export_log.target` and refuses more than 300 000 rows (CR413).
    `dedupe` and `requireEmail` are applied by the app. `backup_export` / `backup_restore` reference everything by natural
    key (status and tag names, member e-mails, list and network names, `regKey`); `lead.version` is not restored.
14. **`import_begin`** refuses with `CR422 database_full` above 450 MB (SPEC 5.4 asked for the UI; the database enforces it
    too) and turns a `running` run older than 2 hours into `failed` before it looks for a lock.
15. **`val.params`** (via `setting_set`) must contain the five numeric limits and `staleBefore` (`YYYY-MM-DD`).
16. **`supabase/config.toml`:** `[auth.email] enable_signup` was `false`; in the CLI that flag disables the e-mail provider
    itself (password sign-in answered `email_provider_disabled`). It is now `true`; new sign-ups stay blocked by
    `[auth] enable_signup = false` (verified: `/auth/v1/signup` answers `signup_disabled`, admin-created users sign in).

Recorded by the IMPORT + VALIDATION builder (`app/src/features/import`, `features/validation`, `workers`).

17. **`hAll` formula.** The worker computes `hAll = h([1, regKey, contentHash])`, where `contentHash` is the first 8 bytes of
    SHA-256 over `JSON.stringify(normalised record)` (16 hex digits; `d` stays the original string inside the record). The
    contract wrote `h([1, regKey, record…])`; the book-number sequence `kseq` (hence `regKey`) is only known after the whole
    file is read, and hashing the record text a second time would need a second full pass. Both forms change exactly when
    the register key or the record content changes, and the database only stores and compares the value. `hContact` is as
    in 6.3, `hDerived = h([1, ...Object.values(derived)])` (flat list in `DerivedFields` key order). `HASH_VERSION` stays 1.
18. **Two passes over the file.** Pass 1 keeps one light record per entry (no `d`), computes keys, hashes, accounts, flags
    and proposals; the full rows of new / changed / returned entries are built in pass 2, which re-reads the file while
    batches are sent (a first import of 264 k entries stays near 700 MB in the worker; measured scan 27 s, rows 13 s in
    Node, 24 s analysis in headless Chrome). The engine refuses a file that changed between the passes.
19. **`kseq` order** compares with plain `<` on `(wpis null last, name, nip, file order)`, not with locale rules, so it is
    identical in every browser.
20. **Oversized detail.** A row's `rec` above ~900 000 characters would be refused by the database (1 MB). The worker then
    drops the largest keys of `d` (replacing arrays by `[]`) and adds `d.trunc: [dropped keys]`; the entry is still
    imported and counted in the preview ("zapisane w skróconej postaci"). The real file (2026-11-14) needs this for 0 entries.
21. **Format-change guard** (SPEC 4.10) is applied per source: a source of at least 20 records where more than half have no
    name or no NIP, or a source of at least 50 records where none has any e-mail or phone, refuses the file.
22. **Labels** (`import_labels`) are sent only for values seen in the file: `p.spec` (`kod — nazwa` from the header names),
    `p.fn`, `p.grp`, `p.status`, `p.formType`, `p.woj`, `r.woj`, `r.src`, `r.status`. Group names, status and form-type
    labels are constants in `features/import/engine.ts`.
23. **Automatic generic domains** (used by >= 30 accounts in >= 3 voivodeships) are recomputed on every import and are not
    written to `generic_domain` (no RPC for that in the contract); owner rows still win. A `generic` row matches its
    sub-domains (Deviations 11).
24. **`import_crm_work`** (Deviations 3) is called through a loosely typed call until `contract.ts` has it; a failure only
    hides the "leady z pracą" sample in the preview.
25. **`qEmail`** is computed for every entry that has a valid e-mail (SPEC says "practices null"; practices carry no e-mail
    in the real data, so nothing changes today). `EMAIL_*` flags come from the primary e-mail only.
26. **Proposal details.** `person` ignores licence numbers shorter than 4 characters or made of one repeated character and
    shared by more than 20 accounts; `partner` needs the partner's NIP to be checksum-valid; `reg_duplicate` members are
    the account keys of the colliding entries (one key when both share a NIP); `account_check` has the account key as its
    only member. Real file (2026-11-14), counts: account_check 170, reg_duplicate 3, person 1 087, partner 2 365,
    email 1 127, domain 432, www 648, phone 11 826 (before item 38: phone proposals now need two podmiot accounts and have
    confidence 60, about 905 on the same file).
27. **`parsePhone` returns `{n, cls}[]`** (as the offline tool), not bare strings; `recordNums(tel, phones)` is the `nums`
    of V2.1.3. `app/src/lib/links.ts` (`nationalNumber`, `isMobileNine`) and `lib/template.ts` (`tidyName`) can now
    delegate to `parsePhone`, `phoneClass`, `cleanName` (Deviations 1).
28. **Walidacja decisions** go through `val_decide` only; the merge on `person` / `reg_duplicate` accept, the split on
    `account_check` reject and the network moves are done inside it (Deviations 10). The screen shows which entries a reject
    would split out, offers "Rozdziel ten wpis" (`val_account_link detach`) per entry, and sends one `val_decide` per
    proposal of a grouped card (the first creates the network, the others join it by id).
29. **Interrupted imports.** The run id is kept in `localStorage` (`rpwzl.import.run`) only to offer "Zamknij przerwany import"
    (`import_abort`) after a reload. Resuming needs nothing else: calls 6-9 are idempotent, so choosing the same file again
    classifies the entries already stored as unchanged and sends only the rest.

Recorded by the integrator (2026-11-15).

30. **`contract.ts` brought in line with the database** (Deviations 2 and 3): `NextStepFilter` gained `'due'` (next step
    today or overdue; used by the system view "Do kontaktu dziś") and `Rpc` gained `import_crm_work`
    (`{p_key_hashes: string[]} -> string[]`, owner). `describeFilter.ts` labels `'due'`.
31. **pg_safeupdate.** Supabase enables the `safeupdate` library for the API roles, so an `UPDATE` or `DELETE` without a
    `WHERE` raises `21000 UPDATE requires a WHERE clause` inside an RPC although pgTAP (role `postgres`) does not notice.
    `private.import_entries_core` had such an `UPDATE _imp` (the whole temporary table); it now ends with `where true`.
    `scripts/lint_sql_where.py` (run by `scripts/check.sh`) rejects any migration statement of this kind, and the e2e import
    test runs the real HTTP path.
32. **Index version 1 is refused** by the import screen (message `MSG_V1`: the file lacks the register book number), as
    designed by the IMPORT builder; the e2e test checks the refusal, and the import of a version 2 file.
33. **E2E layout.** `app/e2e/global-setup.ts` runs `supabase db reset` and creates the local users through the local admin
    API (refuses anything but 127.0.0.1); set `E2E_SKIP_RESET=1` to skip the reset while debugging. One worker, files in
    name order; `90-import.spec.ts` runs last because its file replaces most seed entries. `mocked.spec.ts` / `smoke.spec.ts`
    (browser-side mock of the backend) still pass against the real build.

Recorded by the FIXER (2026-11-15, after the security, real-data, e2e and validation reviews).

34. **Account keys are checked by the database** (SEC-02): `private.bad_account_key` rejects a derived account key of the
    wrong shape or one that contradicts `crm.val_decision`. The worker still applies decisions first; the check only stops
    an old or hand-edited client from undoing them.
35. **`ExportRow.inRegister`** was added (COR-01) so the Customer.io `in_register` column is true only for entries still in
    the register. The Customer.io file is meant for the Customer.io import, not for Excel (the dialog says so).
36. **`QFLAG.EMAIL_FROM_WWW` (bit 20)** marks a practice whose e-mail was typed into the WWW field (VAL-8). The worker uses
    it as the practice's `email` / `emails` (the register `rec` is unchanged) and `ma e-mail` / the exports count it.
    `WWW_INVALID` stays set for it (the field is not a web address). A street address in WWW is `WWW_INVALID`
    ("adres w polu WWW").
37. **`person` proposal value** is `npwz:<profession>:<number>` with profession `lek` (Rpz, Rpzg), `piel` (Rpzp, Rpzpg),
    `fizjo` (Rpf, Rpfg), `diag` (Rpdl, Rpdlg): the four licence-number series are separate (VAL-3). Proposals stored by an
    earlier import under the old value `npwz:<number>` become stale on the next import (their kind is produced again).
38. **`phone` proposals** need at least two podmiot accounts sharing the number (confidence 60, was 50; VAL-2). A podmiot
    plus practitioners listing its phone is not a proposal any more. Real file before the change: 11 826 phone proposals,
    about 25% real networks; the new rule keeps about 905. The informational list "Praktycy z tym numerem" on the card
    (suggested in the review) is not built: it needs a new card field; the filter `Szukaj` finds entries by phone.
39. **Group practices with the first partner's NIP** (VAL-1): the index fills `nip` of a group practice with the first partner's
    NIP when the practice has none. When a type 5 entry's NIP is one of its own partners' NIPs the worker gives it its own
    account (`e:<keyHash>`), does not use the NIP for `telShared` owners, and keeps `GROUP_NIP_IS_PARTNER` ("brak własnego NIP
    praktyki"). The card shows "brak NIP praktyki (NIP wspólnika: …)". The cleaner fix is for the offline index to carry
    the practice's own NIP separately (`nipFromPartner`); it is not changed here (read-only source).
40. **Account check refinements** (VAL-4, VAL-5, VAL-9): a podmiot of form spółka cywilna / jawna / partnerska together with
    a group practice under the same NIP is the same subject and is not flagged; an account of only individual practices is
    flagged when it has at least two licence numbers and two different names; a podmiot without a legal form is typed from
    its name (public institution → 3) and is a JDG when a practice with the same NIP has the same name tokens.
    Not built: a "forma nieznana" label on the card.
41. **Domain lists** (VAL-6, VAL-7): free, typo, generic and social lists were extended in `rules.ts` and the seed
    (`core_tables.sql`); fuzzy typo matching (distance 1) applies only to `gmail.com` and `interia.pl`; short ISP domains
    (pnet.pl, net.pl ...) are no longer typos. `psse-*` / `wsse-*` sanepid hosts are generic in the worker only (a
    pattern, not a table row), so the database's live `email_quality` still scores them as company domains.
42. **RD-2 not changed.** After accepting a `person` proposal the SQL recompute (`recompute_accounts`) updates account size and
    primary only; the next import recomputes the derived values of those entries (reported as "dostanie tylko odświeżone
    wyniki walidacji"). The two computations cannot be made identical without copying the worker rules into SQL, and the
    difference self-heals; CRM data is never touched.
43. **SEC-07 dictionary guard.** `import_entries` rejects a row with more than 200 facet values (raised to 2 000 by item 51) (`CR422`) and a batch with more than
    2 000 genuinely new dictionary values (`CR413`). Before inserting new values `import_entries` and `import_labels` set the
    `crm.reg_dict` sequence back to `max(id)` (only one import run exists at a time) and refuse with `CR422 dictionary_full`
    when the `smallint` range would overflow. `db_usage` gained `dictValues` and `dictLimit` (optional fields in `DbUsage`).
    `reg_dict.id` stays `smallint` (changing it would widen `fv` and `reg_org` on 264 k rows).
44. **SEC-08.** `backup_restore('val_decision')` skips an `attach` row whose `accountKey` is not `n:<10 digits>` or `e:<16 hex>`
    (counted as skipped).
45. **VAL-R2-1.** `Light` gained `partnerNpwz`; `npwz` holds only the practice's own licence. Group-to-partner links without a usable
    NIP are `partner` proposals with `matchValue` `npwz:<profession>:<number>`. SQL safeguard in `val_decide`.
46. **VAL-R2-2.** `crm.v_open_member` excludes `partner` proposals.
47. **VAL-R2-3.** `ACCOUNT_CHECK` for practice-only accounts counts persons after collapsing names that contain one another
    (initials match their full token); at least two must remain. The suggested "first tokens differ" test was not used because the
    register's name order is not fixed (`Anna Nowak` / `Nowak Anna`).
48. **VAL-R2-4.** Domain lists extended in `rules.ts` and the seed migration. `classifyDomain`: a sub-domain of a free domain is free
    (`.gmail.com` sub-domains are typos), typo rules for the last label, `poczta` prefix and 1-3 character `.pl` names. The
    database's `domain_class` knows the lists and the free sub-domain rule, but not the fuzzy typo rules (those run in the worker
    only). Generic suffixes `.edu.pl`, `.net.pl`, `.lm.pl` (owner-editable) — removed again by item 63.
49. **VAL-R2-5.** `www` proposals below the strong condition get confidence 45 (hidden by default); portal hosts added to the social list.
50. **Rejected: RD-2** (see 42), no change. **E5**: layout `min-width: 0` and `minmax(0, 1fr)` grid tracks so only the table wrapper scrolls.
    **E2b**: the error boundary does not auto-reload while `navigator.onLine` is false. **TEST-01b**: `supabase test db` needs a fresh
    `db reset` (CLAUDE.md, `check.sh`); not made independent of leftover data.

Recorded by the round-3 fixer (2026-11-15, after the third security, real-data, e2e and validation reviews).

51. **RD-6 (blocker): per-row facet cap 2 000.** The cap of 200 facet values per row refused 65 real podmioty (large hospitals and
    networks). Measured on the real file (2026-11-14, offline engine, aggregates only): largest row 371 values (then 347, 329,
    322, 315), 0 rows above 400; a first import in 500-row batches brings at most 136 new dictionary values per batch (limit
    2 000) and 3 496 in total; `import_labels` sends 783 labels in one call. The per-batch `CR413` cannot be reached by the
    real file. pgTAP: a row of 402 values over five facets is accepted and stored, 2 001 values are `CR422`. The import screen
    now says, for a `CR422` / `CR413` during import, that the database refused the file's data, shows the database's detail
    and does not suggest retrying the same file.
52. **SEC-12.** The dictionary section of `import_entries_core` and `import_labels` takes `pg_advisory_xact_lock(7243001)`
    (`private.lock_reg_dict`) before re-synchronising the sequence, and recounts the new values after the lock, so two
    concurrent calls of one run serialise instead of failing with a raw 23505.
53. **SEC-13.** `import_labels` refuses more than 2 000 genuinely new values per call (`CR413`). New `contract.ts`
    `ERROR_KEY_TEXT_PL` maps error keys to dedicated Polish texts (`dictionary_full`: do not retry, contact the
    administrator; `database_full`; `account_check_first`); `api.ts` uses it before the generic text of the code.
    Ustawienia → „Miejsce w bazie” shows `dictValues` / `dictLimit`; OPERATIONS 3 describes the condition.
54. **SEC-14.** `crm.v_open_member` is created `with (security_invoker = true)`; pgTAP checks that no view in `crm`,
    `private`, `api` lacks it.
55. **SEC-09.** `private.bad_derived` refuses (`CR422`, detail names the field) `entityType` outside 1..5, `nipStatus`
    outside 0..4, `accountSize` < 1, negative or > int `qflags`, `qEmail` / `qPhone` outside 0..100, negative `telShared`,
    more than 50 `nums` (real maximum 17) and a non-boolean `isAccountPrimary`, in `import_entries` and `import_derived`;
    `import_derived` also refuses the same `keyHash` twice in one batch.
56. **SEC-10.** `private.raise_err` coalesces a null detail, so `lead_get(null)`, `val_decide(null, …)` and every other
    `'… ' || null` detail give their CR code (`CR404`) instead of 22004.
57. **SEC-11.** `import_entries` refuses `org` or `ks` containing `|` (the `regKey` separator). Real file: 0 such rows.
58. **SEC-05.** `backup_restore`: `team_member` rows are always restored as role `member` (a file never creates owners; the
    owner promotes people again, OPERATIONS 7); `app_setting` only takes the six known keys (all seeded, so nothing is
    overwritten); `check_violation`, `foreign_key_violation`, `not_null_violation` and `string_data_right_truncation` are
    `CR422`; a `detach` decision stores no `accountKey` text.
59. **COR-02.** The temporary tables `_imp`, `_lab`, `_prop` are dropped (when present) and re-created `on commit drop` on every
    call, so a pooled connection never keeps the structure of an older migration.
60. **SEC-06.** `app/public/_headers` carries the same CSP / frame / nosniff / referrer headers as `vercel.json` for Netlify and
    Cloudflare Pages. `vite.config.ts` fails the build when `VITE_SUPABASE_PUBLISHABLE_KEY` starts with `sb_secret_` or is a
    JWT whose role is `service_role` (the value is never printed).
61. **SEC-04.** OPERATIONS 2 now says to create the auth user right after the allowlist row and to always delete a removed
    person's auth account. Not built: linking only when `auth.users.email_confirmed_at` is set (the hosted project confirms
    e-mail changes; the documented procedure closes the gap).
62. **SEC-03 accepted.** A member can read every register contact page by page (that is how lead work is done); there is no
    per-member volume counter. Written down in OPERATIONS 4 (trusted users only, revoke access promptly).
63. **VAL-R3-1, VAL-R3-7: public suffixes.** The seed no longer lists `com.pl`, `net.pl`, `edu.pl`, `lm.pl` as generic, and the
    worker has no `.edu.pl` / `.net.pl` / `.lm.pl` suffix rules. A `generic` (or, in SQL, `free`) row for a public
    second-level suffix (`rules.ts PUBLIC_SUFFIXES` = SQL `private.public_suffix`) matches only that exact domain, so even an
    owner row for `com.pl` cannot hide `alab.com.pl`. Free (with sub-domains): `ape.net.pl, alias.net.pl, ak.net.pl,
    toya.net.pl, uznam.net.pl, krynica.net.pl, malbork.net.pl, konin.lm.pl, creator.wroc.pl, gryf.info.pl, amorki.pl,
    mierzeja.pl, 2com.pl, tpnet.pl, mail.pl, opoka.org.pl, kkw.com.pl`. Generic: the 16 regional `nfz-*.pl` domains (also a
    worker pattern), `nfz.gov.pl`, `teb-edukacja.pl`. A vitest loads the seed rows from the migration as the DomainTable.
    Real file with the seed: domain proposals 334 → 362, www 589 → 632 (71 of them `.com.pl` networks).
64. **VAL-R3-2, VAL-R3-3, VAL-R3-5: person proposals.** Accept moves only the individual practices (type 4, the
    profession's source) whose `rec.d.npwz` is the proposal's licence number, never whole accounts; target = a member with
    an `n:` key first, then the account with more entries, then the key. Refused with `CR422 account_check_first` while a
    member account mixes types 1/3 with practices, carries `ACCOUNT_CHECK`, or holds a practice of the same profession under
    another licence number. The worker gives confidence 90 only when the holders' names nest (diacritics folded) and no member
    account is in `accountCheck`, else 55; the card explains which ("Najpierw rozdziel konto" / "inne imię lub nazwisko") and
    the merge hint describes the new behaviour. Real file: 94 person proposals, 70 at 90 and 24 at 55.
65. **VAL-R3-4.** `02.pl → o2.pl` (rules and seed); a 1–2 character `.pl` name is a typo without a suggestion; a rule-derived
    typo that is the domain of any WWW field in the file (`hostDomains`, passed to `classifyDomain` / `emailQuality` as
    `webDomains`) is a company domain (cos.pl, wpr.pl). The WWW rule runs in the worker only; the database's live
    `email_quality` does not know the fuzzy typo rules anyway (item 48).
66. **VAL-R3-6: shared mobiles.** contract.ts `QFLAG.MOBILE_SHARED` (bit 21, not a problem bit). `mobile` = the first mobile of
    `nums` used by fewer than 5 owners (`nipKey` or account key, all kinds); the shared number stays in `nums`. So cflags
    `MOBILE` ("ma komórkę") and the Customer.io `sms_phone` skip call-centre numbers without any SQL change. This departs
    from the offline tool's `mobile` (V2.1.3); the saved-view "mobile" counts drop accordingly (real file: practices with
    `mobile` 49.4 % → 40.2 %; 36 332 entries flagged).
67. **VAL-R3-8, VAL-R3-9.** A podmiot without a legal form is a JDG when its name nests (either way, ≥ 2 tokens, diacritics
    folded) with a same-NIP individual practice's name, or when it starts with "osoba fizyczna" (real file: JDG podmioty
    11 251 → 11 270, account_check proposals 198 → 191). A NIP whose first digit is 0 is `PLACEHOLDER` in `nipStatus`, its
    SQL twin `private.nip_status` and `nipKey` (no `n:` account, no owner key). SQL `private.entity_type` has no name rule
    (the worker sends the type).
68. **UI nits.** E7: the call script fills `{{ulica}}` from the register and drops separators left by an empty variable; the
    card's validation select is wider with a shorter label („Automatycznie: …”); the Users table has an „Edycja” header; a
    forced sign-out shows „Sesja wygasła. Zaloguj się ponownie.” on the login screen; the status pill does not wrap.
    E2b-b: a second error boundary and Suspense sit inside the shell, so a screen that fails to load keeps the menu. E5-b:
    tighter table cells up to 1440 px. RD-4: the export dialog warns above 50 000 rows. RD-5: `public/favicon.svg`.
69. **Declined: RD-2** (unchanged, see 42 and 50; the reviewer marked it "none needed"). **Declined: RD-3** (`pg_trgm` index for
    free-text and city search): a trigram index on 264 k names (and cities) would take an estimated tens of MB of the 500 MB
    Free plan and slow every import; 260–370 ms per search is acceptable for three users. Revisit if the team grows.

70. **Round 2 (2026-11-15).** Customer.io file (`lib/csv.ts`): `website` is the normalised host from `wwwQuality` (empty
    when invalid or social; the first valid host of a list; RDV-1); `email` is lower-cased and, when the best e-mail cell is
    not one valid address, its first valid part or the first valid address of `emails` (else the row counts as "brak
    e-maila"; RDV-2); dates before 1970 are left empty (RDV-6); `exportFileName(label, ext, date, suffix)` shortens the
    label (at a word boundary) before the suffix (RDV-5). RDV-3: DATA_MODEL 3.2 / 9.3, SPEC 9.3 and OPERATIONS 5 carry the
    measured sizes (register 215 MB, projection 374–394 MB); **open owner decision**: accept, or pull a lever (12 refreshes
    of history −7 MB, partial account index −8 MB). RDV-4: `filter_accounts` treats `{}` like null (`{}` selects entries in
    the register only, null every proposal: the counts differ only by proposals whose every member left the register).
    RDV-7: OPERATIONS 3.6 says the first import depends on upload speed; trimming `rec` fields from the payload is
    declined for now (it changes the detail format and `hAll`, and the import is a one-off). SEC-R3-N1: key texts are
    looked up with `Object.hasOwn`.
71. **VAL-R4-1, VAL-R4-2, VAL-R4-4: person merges and JDG accounts.** `val_decide` (person accept) picks the target only
    among member accounts holding a practice with the licence: first an account whose entries all name that person
    (`private.same_person` against the licence holders), then `n:`, size, key. The refusal no longer trusts the import's
    stored ACCOUNT_CHECK bit once the account has a single entry or its `account_check` proposal is decided; the type mix
    and the other-licence rules still read the current accounts. `private.account_link` adds the new account key of a
    moved individual practice to every open `person` proposal for its licence, so "split, then accept" works before the
    next import. `private.minority_entries` (reject on `account_check`) now also splits accounts without a company: the
    individual practices whose holder is not the JDG's person (without a JDG: not the primary's person). Worker
    (`derive.ts`): an account of a JDG and individual practices is ACCOUNT_CHECK when a practice holder is not the same
    person as any JDG name (`samePersonTokens`: names nest, or the surname of either occurs in the other, or ≥ 2 shared
    tokens; a leading "osoba fizyczna" ignored). Real file: account_check proposals 191 → 264 (+73: practitioners using
    another person's NIP and changed surnames, plus a few transliterations such as Anastasia / Anastazja that the team
    accepts), person proposals at 90 → 55: 1 (the VAL-R4-1 case), the VAL-R4-4 account is checked again.
72. **VAL-R4-3: domains.** `hostDomains` leaves out public suffixes; a bare public suffix as e-mail domain is a typo without
    a suggestion (`classifyDomain`, and seed rows `com.pl`, `net.pl`, `org.pl`, `edu.pl`, `waw.pl` of kind `typo`, which
    match only themselves); `elblag.com.pl`, `sanok.com.pl`, `grudziadz.com.pl`, `tenit.com.pl`, `sanatoria.com.pl` are
    free; medical-university domains (`GENERIC_UNIVERSITIES`, 14 rows) are generic with their sub-domains;
    `medycyna.net.pl` is social; `poczta.net.pl` is a typo of `onet.pl`. Real file: domain proposals 362 → 350 (the 12
    listed false ones gone, none added), www 632 → 631.
73. **UI (UX-R3-1..5, E5-b, RDV-8).** The card's validation select fills its grid cell (no `min-width`) with the shorter
    label „Auto: …” (full wording in its title); at ≤ 900 px the shell has three rows, so the menu no longer stretches, and
    every `.grid` table sits in `.table-wrap`; action cells stay table cells; below 1366 px the Leady name and e-mail
    columns are narrower so Walidacja fits; the Leady help text names the „Pokaż filtry” button. Import failures
    (`features/import/failure.ts`): CR422 / CR413 open with „Baza danych odrzuciła dane z tego pliku…”, key texts are not
    repeated, the database detail is on its own line („Szczegóły dla administratora:”, copy button), non-retryable
    failures offer „Wróć do importu” as a secondary button, CR423 says „Nic nie zostało zapisane. Spróbuj ponownie za
    kilka minut.” Fixtures: synthetic phone numbers and names replace values that matched the register (PII-R3-1, PII-R3-2).
74. **Round 3 (2026-11-15): identity, splits, person accepts.** One person rule, twins kept in step (`derive.ts
    samePersonTokens` = SQL `private.same_person`): two names are the same person when one nests in the other or the first
    token of either, when not an initial, occurs among the other's tokens (VAL-R5-1, VAL-R5-2). A shared surname alone
    ('Robert Test' / 'Urszula Test') or a shared first initial no longer counts; a changed surname with the same first name
    does. No edit-distance tolerance: it would merge 'Stanisław' / 'Stanisława' or 'Daniel' / 'Daniela'. Name tokens fold
    every Latin-1 / Latin Extended letter that decomposes, plus ł ø đ ı ħ ŧ and ß æ œ (VAL-R5-5); checked locally on all
    238 608 distinct register names: SQL and worker tokens identical. `private.minority_entries` (reject on an
    `account_check` without a company) and the worker's twin `detachedPractices` detach the individual practices that are
    not the same person as the JDG's name (else the primary's) and do not carry a reference licence number; the worker
    flags such an account exactly when that list is not empty, so the flag and the split agree. `val_proposal_get` returns
    `detachIds` for an open `account_check` (contract.ts `ProposalDetail.detachIds`), the card lists those entries, names
    the conflict („ten sam NIP ma JDG i praktyka innej osoby” …), and says when a reject would detach nothing. The
    ACCOUNT_CHECK label is „ten sam NIP mają różne podmioty lub osoby”; `PROPOSAL_KIND_PL.account_check` is „Konto do
    sprawdzenia (ten sam NIP)”. Person accept (RD2-1): the refusal rules read only member accounts that hold a practice
    with the licence, so the account the person was split out of no longer refuses; the other-licence rule counts a
    practice only when its holder is another person by name (RD2-2). **Declined (RD2-2 first option):** "two numbers of one
    profession are two people whatever the names": on the real file 249 practice-only accounts hold one name with two
    numbers of one register (a doctor's and a dentist's number in `Rpz`, a nurse's `…A` and a midwife's `…P` in `Rpzp`);
    that rule raised account checks from 264 to 459. Real file now: account_check 264 → 208 (139 company + practice, 21 JDG,
    48 practices only), entries with ACCOUNT_CHECK 462, person 94 (69 at 90, 25 at 55); other kinds unchanged.
75. **Round 3: domains, SMS, UI.** VAL-R5-3: only `com.pl, net.pl, org.pl, edu.pl, waw.pl` (the seed's `typo` rows) are a
    typo as a whole e-mail domain; city suffixes (sopot.pl, krakow.pl) are company domains, as in SQL. VAL-R5-4: `iq.pl` is
    free (rules and seed); a 3 character `.pl` near miss gets a suggestion only towards wp.pl / o2.pl / op.pl / vp.pl. RD2-5:
    `business.site` sub-domains are social, for e-mail domains and in `wwwQuality` (so not a Customer.io `website`); the
    seed's `social` rows match exactly, as before (no SQL change). RD2-4: the SMS composer starts on a CRM-primary mobile,
    else the entry's `mobile`, else the first mobile shared by fewer than `MOBILE_SHARED_OWNERS` accounts, and warns on a
    shared mobile. UX-R4-1: „Nazwa” has `min-width: 220px` (3 lines below 1366 px); „Miejscowość” shows the city, the
    voivodeship in its tooltip. UX-R4-2: every import file error ends with a next step (re-save in the RPWDL tool, or tell
    the administrator; a newer index version says the CRM needs an update); a file that never names the index format is
    "not an index". UX-R4-3: the „Powiązane” table sits in `.table-wrap`. UX-R4-4: Polish plural for „konto / konta /
    kont”, no dash above a phone, a single reason equal to the title is not repeated, Konto tables share column widths.
    RD2-3: DATA_MODEL 9.3, SPEC 9.3 and OPERATIONS 5 carry the re-measured sizes (projection 374–396 MB); the per-import
    `last_run` rewrite of `val_proposal` (≈ 2 MB) is left as is. REG2-N1: textbook placeholder names in `issues.test.ts`
    are now synthetic. REG2-N2: unchanged, as documented in item 70.
