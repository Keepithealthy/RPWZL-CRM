# RPWZL CRM — Claude Code instructions

CRM for Keep It Healthy's sales team (3 users) over the public RPWDL register (~264 k entries: 29.8 k podmioty
lecznicze, 234 k praktyki zawodowe). Owner is not a programmer: hand back decisions in plain Polish, carry the
technical work. Conversation with the owner: Polish. UI text: Polish. Code, comments, commit messages and docs
under `docs/` (except `OPERATIONS.md`, which is Polish for the owner): English.

## Read first

`docs/SPEC.md` (what), `docs/DATA_MODEL.md` (tables, size budget), `docs/CONTRACT.md` (RPCs, import mapping,
directory ownership), `app/src/lib/contract.ts` (typed contract; change it only together with CONTRACT.md).

## Layout

- `app/` — Vite + React 19 + TypeScript SPA, TanStack Query/Table, supabase-js; vitest (happy-dom), Playwright.
  `src/lib/` shared (contract, supabase client, api wrapper), `src/features/<screen>/`, `src/workers/`
  (import Web Worker), `src/features/validation/rules.ts` (pure validation rules shared by worker and UI).
- `supabase/` — Supabase CLI layout: `config.toml` (exposes only schema `api`), `migrations/*.sql`,
  `tests/*.sql` (pgTAP), `seed.sql` (synthetic only).
- `docs/` — specs and the owner manual.

## Commands

| where | command |
|---|---|
| `app/` | `npm ci` (Node ≥ 22.12; `.npmrc` sets `legacy-peer-deps=true` because npm 10.9 crashes on vitest's optional peers) |
| `app/` | `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run e2e` (needs the local stack) |
| repo root | `npx supabase@2.122.0 start` / `db reset` / `test db` / `stop` (Docker; ports 54321–54329). `test db` needs a freshly reset database (`db reset` first): e2e runs leave rows that the pgTAP counts do not expect |
| repo root | `scripts/check.sh` runs everything below against the local stack (SQL lint, db reset, pgTAP, typecheck, lint, unit, build, e2e); `--no-e2e` skips Playwright |

Never use port 5432 (another project's database runs there). Throwaway Postgres containers for experiments use
other ports and are removed afterwards.

## Rules

- **No real register data in the repo**: no records, names, phones, e-mails, NIPs in fixtures, tests, seeds,
  logs, screenshots or commit messages. Tests use synthetic generators. Real index files and experiments stay in
  `/tmp/claude-work/crm-work/<label>/`.
- **Production is off-limits without the owner's explicit approval**: no `supabase db push`, no Supabase or
  Vercel MCP tools that change anything (apply_migration, execute_sql, deploy…). `mcp__Supabase__search_docs`
  is fine. Never print, create or move secrets; only the publishable key may be in the client.
- **Size budget**: Free plan, 500 MB. Any new column on `crm.reg_entry` costs ~264 k × its size; measure before
  adding indexes or columns to register tables (DATA_MODEL 9). No whole-table `UPDATE`s on register tables.
- **One writer per field**: imports never write CRM tables; user RPCs never write register tables.
- **Security**: tables only in schema `crm` (not exposed), every RPC in `api` is `security definer`,
  `set search_path = ''`, starts with `private.require_member()` / `require_owner()`; RLS on, no policies; no
  grants to `anon`.
- Render register text as text only (no `dangerouslySetInnerHTML`).
- Minimal, task-scoped diffs; respect directory ownership in CONTRACT.md 1; dependencies are pinned exactly —
  ask before adding one.
- Commit, push or open a PR only when the owner asks. Work on branch `claude/crm-v1` (or the branch the session
  assigns), never on `main`.
- Report only results of commands actually run in the session; say "not run" otherwise.
