#!/usr/bin/env bash
# Runs every automated check of the project against the LOCAL Supabase stack (Docker). Nothing here touches a hosted
# project. Usage: scripts/check.sh [--no-e2e]
# Steps: SQL lint, local stack up, db reset, pgTAP, app typecheck, lint, unit tests, build, Playwright e2e.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
SUPA="npx --yes supabase@2.122.0"
RUN_E2E=1
[[ "${1:-}" == "--no-e2e" ]] && RUN_E2E=0
declare -a NAMES RESULTS

step() { # step <name> <command...>
  local name="$1"; shift
  echo; echo "=== $name"
  if "$@"; then NAMES+=("$name"); RESULTS+=("PASS"); else NAMES+=("$name"); RESULTS+=("FAIL"); fi
}

stack_up() {
  # db, auth, rest, kong are enough for the app; the rest is excluded to save pulls.
  if $SUPA status >/dev/null 2>&1; then echo "local stack already running"; return 0; fi
  $SUPA start -x realtime,storage-api,imgproxy,edge-runtime,logflare,vector,studio,mailpit,postgres-meta,supavisor
}

env_local() {
  # app/.env.local (git-ignored) holds only the LOCAL URL and the LOCAL publishable key.
  [[ -f app/.env.local ]] && return 0
  local out url key
  out="$($SUPA status -o env 2>/dev/null)" || return 1
  url="$(sed -n 's/^API_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' <<<"$out")"
  key="$(sed -n 's/^PUBLISHABLE_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' <<<"$out")"
  [[ "$url" == http://127.0.0.1* && -n "$key" ]] || { echo "local stack not reachable"; return 1; }
  printf 'VITE_SUPABASE_URL=%s\nVITE_SUPABASE_PUBLISHABLE_KEY=%s\n' "$url" "$key" > app/.env.local
}

in_app() { (cd "$ROOT/app" && "$@"); }

step "SQL lint: UPDATE/DELETE without WHERE (pg_safeupdate)" python3 scripts/lint_sql_where.py supabase/migrations
step "Local Supabase stack running" stack_up
step "app/.env.local present (local URL + publishable key)" env_local
step "supabase db reset (all migrations + synthetic seed)" $SUPA db reset
# pgTAP counts assume the seed only, so it must run right after the reset above (never after e2e on the same database).
step "pgTAP: supabase test db" $SUPA test db
[[ -d app/node_modules ]] || step "app: npm ci" in_app npm ci
step "app: typecheck" in_app npm run typecheck
step "app: lint" in_app npm run lint
step "app: unit tests (vitest)" in_app npm test
step "app: build" in_app npm run build
if [[ $RUN_E2E == 1 ]]; then
  # The e2e global setup resets the local database again and creates the local test users (local admin API).
  step "app: e2e (Playwright, local stack)" in_app npx playwright test
fi

echo; echo "================ SUMMARY"
fail=0
for i in "${!NAMES[@]}"; do printf '%-6s %s\n' "${RESULTS[$i]}" "${NAMES[$i]}"; [[ "${RESULTS[$i]}" == FAIL ]] && fail=1; done
exit $fail
