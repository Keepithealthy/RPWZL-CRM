# RPWZL CRM

Small CRM for Keep It Healthy's sales team: leads from the public RPWDL register (all podmioty lecznicze and
praktyki zawodowe), validation of "who is who", pipeline, activities, tasks, templates, exports (CSV and
Customer.io). Polish UI, three users, Supabase Free plan.

| path | content |
|---|---|
| `docs/SPEC.md` | product and functional specification |
| `docs/DATA_MODEL.md` | tables, indexes, security, size budget (measured) |
| `docs/CONTRACT.md` | RPCs, payloads, import mapping, directory ownership |
| `docs/OPERATIONS.md` | owner manual (Polish): users, import, export, backup, paused project |
| `app/` | Vite + React + TypeScript SPA (static; `app/src/lib/contract.ts` = typed contract) |
| `supabase/` | Supabase CLI project: `config.toml`, `migrations/`, `tests/` (pgTAP), `seed.sql` (synthetic) |

## Quick start (developers)

```bash
cd app && npm ci            # Node >= 22.12; .npmrc sets legacy-peer-deps (npm 10 bug with vitest peers)
cp .env.example .env.local  # local values from `npx supabase@2.122.0 status` (never commit .env.local)
npm run dev                 # http://127.0.0.1:5173
npm run typecheck && npm run lint && npm test
```

Local database: `npx supabase@2.122.0 start` from the repo root (Docker; API on 54321, DB on 54322, Studio on
54323), `npx supabase@2.122.0 db reset` applies migrations and the synthetic seed, `npx supabase@2.122.0 test db`
runs `supabase/tests`.

Real register data never goes into this repository (see `CLAUDE.md`).
