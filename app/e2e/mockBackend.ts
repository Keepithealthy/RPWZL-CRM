import type { Page, Route } from '@playwright/test';

/**
 * Self-contained backend for UI e2e: intercepts Supabase Auth and the `api` RPCs, so the SPA can be exercised without
 * the local stack. Synthetic data only. The real-stack e2e (SPEC 9.5) is separate and uses the DB seed.
 */
export interface Captured { name: string; args: Record<string, unknown> }

const statuses = [
  { id: 1, name: 'Nowy', color: '#6b7280', sort: 1, stage: 'open', isDefault: true, active: true },
  { id: 2, name: 'Do kontaktu', color: '#0b5cad', sort: 2, stage: 'open', isDefault: false, active: true },
  { id: 8, name: 'Nie teraz', color: '#aa8800', sort: 8, stage: 'paused', isDefault: false, active: true },
];
export const ME = { memberId: 1, email: 'owner@example.test', displayName: 'Ola Testowa', role: 'owner', phone: '600 000 000' };

const row = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id, kind: 'p', src: 'Rpm', name, nip: `000000000${id}`, email: `biuro${id}@example.test`, tel: '600 000 00' + id, mobile: '60000000' + id, www: 'example.test',
  miasto: 'Testowo', woj: 'testowe', wpis: '2025-03-01', stan: '2026-01-10', nz: 1, nk: 2, spec1: 2, entityType: 1, inRegister: true, qEmail: 80, qPhone: 60,
  qflags: 0, accountKey: `n:000000000${id}`, accountSize: 1, statusId: 1, ownerId: null, tags: [], validation: 0, validationIsDerived: true, dnc: false,
  nextStepAt: null, nextStepNote: null, lastContactAt: null, networkId: null, version: 0, ...over,
});

export const ROWS = [row(1, 'Przychodnia Alfa Sp. z o.o.'), row(2, 'Centrum Medyczne Beta', { dnc: true }), row(3, 'Gabinet Gamma', { inRegister: false })];

function card(id: number) {
  const r = ROWS.find((x) => x.id === id) ?? ROWS[0]!;
  return {
    row: r, regKey: `0|Organ|${id}|1`, ks: `00000000000${id}`, org: 'Organ Testowy', kod: '00-001', facets: { 'p.status': ['aktywny'] },
    rec: { emails: [r.email], phones: [], ulica: 'ul. Próbna 1', rodzaje: ['Ambulatoryjne świadczenia zdrowotne'], dz: [], fn: [], d: { ks: `00000000000${id}`, sie: 'ul. Próbna 1, 00-001 Testowo', z: [{ n: 'Zakład Testowy', k: [{ n: 'Poradnia Testowa', s: '0001' }], j: [] }] } },
    lead: null, contacts: [], account: [], network: null, proposals: [], lists: [], phoneOwners: {}, firstRun: { id: 1, reportDate: '2026-11-14' }, lastChange: null,
  };
}

export async function mockBackend(page: Page): Promise<Captured[]> {
  const captured: Captured[] = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  await page.route('**/auth/v1/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = route.request().url();
    if (url.includes('/token')) {
      return json(route, { access_token: 'test.access.token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'test-refresh', user: { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', email: ME.email, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } });
    }
    return json(route, {});
  });

  await page.route('**/rest/v1/rpc/*', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    captured.push({ name, args });
    const h: Record<string, unknown> = {
      me: ME,
      ref_data: { me: ME, statuses, tags: [], members: [{ id: 1, displayName: ME.displayName, role: 'owner', active: true, phone: ME.phone, email: ME.email }], views: [{ id: 1, name: 'POZ — test', scope: 'system', ownerId: null, filter: { kind: 'p' }, sort: null, columns: null, note: 'Widok testowy', sortOrder: 1 }], lists: [], lastImport: { id: 1, reportDate: '2026-11-14', finishedAt: '2026-11-14T12:00:00Z' }, settings: { staleDays: 35, valMinConfidence: 50, smsDiacritics: 'keep' } },
      dict: [{ facet: 'p.spec', val: '0001', label: '0001 — Medycyna rodzinna' }],
      today: { tasksOverdue: [], tasksToday: [], nextSteps: [], registerChanges: [], counts: { tasksOverdue: 0, tasksToday: 0, nextSteps: 0, registerChanges: 0, openProposals: 2 } },
      leads_count: { total: ROWS.length, email: 3, tel: 3, www: 3, nip: 3, mobile: 3 },
      leads_search: { rows: ROWS },
      leads_facets: { 'p.status': [['aktywny', 3]] },
      lead_get: card(Number(args.p_entry_id ?? 1)),
      lead_timeline: [{ id: 'c:1:1', at: '2026-11-14T12:00:00Z', entryId: 1, source: 'register', type: 'register_new', outcome: null, contactValue: null, subject: null, body: null, statusFrom: null, statusTo: null, fields: null, old: null, byId: null, editable: false }],
      templates_list: [{ id: 1, kind: 'call', name: 'Skrypt testowy', subject: null, body: 'Dzień dobry, mówi {{ja}}. Czy rozmawiam z {{nazwa}}?', active: true, sort: 1, updatedAt: '2026-11-01T00:00:00Z' }],
      activity_add: { activityId: 1, row: ROWS[0] },
      db_usage: { bytes: 230 * 1_048_576, limitBytes: 500 * 1_048_576, tables: [{ name: 'crm.reg_entry', bytes: 110 * 1_048_576 }] },
      lists_list: [], tasks_list: [],
    };
    if (!(name in h)) return json(route, { code: 'PGRST202', message: `mock: ${name} missing` }, 404);
    return json(route, h[name]);
  });
  return captured;
}
