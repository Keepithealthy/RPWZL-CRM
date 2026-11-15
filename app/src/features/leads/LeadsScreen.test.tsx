import '../../test/autocleanup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { leadRow, me, refData } from '../../test/factories';
import { makeRpc, renderApp } from '../../test/render';

const rpcMock = vi.fn();
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), rpc: (...a: unknown[]) => rpcMock(...a) }));
let role: 'owner' | 'member' = 'owner';
vi.mock('../auth/AuthProvider', () => ({ useMe: () => ({ ...me, role }), useIsOwner: () => role === 'owner' }));

import LeadsScreen from './LeadsScreen';

function setup(over: { total?: number; rows?: ReturnType<typeof leadRow>[]; ref?: ReturnType<typeof refData> } = {}) {
  const rows = over.rows ?? [leadRow({ id: 1, name: 'Alfa Przychodnia' }), leadRow({ id: 2, name: 'Beta Centrum', dnc: true, inRegister: false })];
  const t = makeRpc({
    ref_data: over.ref ?? refData(),
    dict: [],
    leads_count: { total: over.total ?? 120, email: 100, tel: 110, www: 50, nip: 120, mobile: 30 },
    leads_search: { rows },
    leads_facets: { 'p.status': [['aktywny', 8167]] },
  });
  rpcMock.mockImplementation(t.fn);
  return t;
}

describe('LeadsScreen', () => {
  beforeEach(() => { rpcMock.mockReset(); role = 'owner'; window.innerWidth = 1600; });

  it('lists rows with badges and the summary bar', async () => {
    setup();
    renderApp(<LeadsScreen />, '/leady');
    expect(await screen.findByText('Alfa Przychodnia')).toBeTruthy();
    expect(screen.getByText('zniknął z rejestru')).toBeTruthy();
    expect(screen.getByText('nie kontaktować')).toBeTruthy();
    expect(await screen.findByText(/Wyniki: 120/)).toBeTruthy();
    expect(screen.getByText(/z e-mailem: 100/)).toBeTruthy();
  });

  it('asks the server for page 1 sorted by default, then sorts by a header and pages', async () => {
    const t = setup({ total: 120 });
    renderApp(<LeadsScreen />, '/leady');
    await screen.findByText('Alfa Przychodnia');
    const first = t.calls.find((c) => c.name === 'leads_search')!;
    expect(first.args).toMatchObject({ p_offset: 0, p_limit: 50, p_sort: null });

    fireEvent.click(screen.getByRole('button', { name: /Miejscowość/ }));
    await waitFor(() => expect(t.calls.some((c) => c.name === 'leads_search' && (c.args.p_sort as { key: string })?.key === 'miasto')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /Następna/ }));
    await waitFor(() => expect(t.calls.some((c) => c.name === 'leads_search' && c.args.p_offset === 50)).toBe(true));
  });

  it('debounces the search box into filter.q', async () => {
    const t = setup();
    renderApp(<LeadsScreen />, '/leady');
    await screen.findByText('Alfa Przychodnia');
    fireEvent.change(screen.getByLabelText('Szukaj: nazwa, NIP, e-mail, telefon'), { target: { value: 'Alfa' } });
    await waitFor(() => expect(t.calls.some((c) => c.name === 'leads_search' && (c.args.p_filter as { q?: string }).q === 'Alfa')).toBe(true), { timeout: 2000 });
  });

  it('shows the bulk bar for selected rows; export only for the owner', async () => {
    setup();
    const { unmount } = renderApp(<LeadsScreen />, '/leady');
    await screen.findByText('Alfa Przychodnia');
    fireEvent.click(screen.getByLabelText('Zaznacz: Alfa Przychodnia'));
    const bar = screen.getByRole('region', { name: 'Akcje zbiorcze' });
    expect(within(bar).getByText(/Zaznaczono: 1 lead/)).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Eksport…' })).toBeTruthy();
    unmount();

    role = 'member';
    renderApp(<LeadsScreen />, '/leady');
    await screen.findByText('Alfa Przychodnia');
    fireEvent.click(screen.getByLabelText('Zaznacz: Alfa Przychodnia'));
    expect(within(screen.getByRole('region', { name: 'Akcje zbiorcze' })).queryByRole('button', { name: 'Eksport…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Eksport wyników…' })).toBeNull();
  });

  it('runs a bulk status change with a confirmation text and the selected ids', async () => {
    const t = setup();
    t.calls.length = 0;
    rpcMock.mockImplementation(makeRpc({ ref_data: refData(), dict: [], leads_count: { total: 2, email: 1, tel: 1, www: 1, nip: 1, mobile: 0 }, leads_search: { rows: [leadRow({ id: 7, name: 'Gamma' })] }, leads_facets: {}, leads_bulk: { affected: 1 } }).fn);
    renderApp(<LeadsScreen />, '/leady');
    await screen.findByText('Gamma');
    fireEvent.click(screen.getByLabelText('Zaznacz: Gamma'));
    fireEvent.change(screen.getByLabelText('Akcja zbiorcza'), { target: { value: 'set_status' } });
    expect(await screen.findByText(/Zmienić status 1 lead na/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zastosuj' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('leads_bulk', { p_target: { entryIds: [7] }, p_action: { action: 'set_status', statusId: 2 } }));
  });

  it('explains how to get data when nothing was imported yet', async () => {
    setup({ rows: [], total: 0, ref: refData({ lastImport: null }) });
    renderApp(<LeadsScreen />, '/leady');
    expect(await screen.findByText('Brak danych z rejestru.')).toBeTruthy();
    expect(screen.getByText(/zaimportować indeks \(menu Import\)/)).toBeTruthy();
  });

  it('applies a saved view and marks it as changed after a filter edit', async () => {
    const view = { id: 5, name: 'POZ — test', scope: 'system' as const, ownerId: null, filter: { kind: 'p' as const }, sort: null, columns: null, note: 'Opis widoku', sortOrder: 1 };
    const t = setup({ ref: refData({ views: [view] }) });
    renderApp(<LeadsScreen />, '/leady?view=5');
    expect(await screen.findByText('Opis widoku')).toBeTruthy();
    await waitFor(() => expect(t.calls.some((c) => c.name === 'leads_search' && (c.args.p_filter as { kind?: string }).kind === 'p')).toBe(true));
    fireEvent.change(screen.getByLabelText('Miejscowość (zawiera)'), { target: { value: 'Gdynia' } });
    expect(await screen.findByText('zmieniono')).toBeTruthy();
  });

  it('starts with the filter column collapsed on a laptop-width screen', async () => {
    window.innerWidth = 1280;
    setup();
    renderApp(<LeadsScreen />, '/leady');
    await screen.findByText('Alfa Przychodnia');
    expect(screen.getByRole('button', { name: 'Pokaż filtry' })).toBeTruthy();
    expect(screen.queryByLabelText('Filtry')).toBeNull();
  });

  it('warns that the rows are stale when the browser is offline', async () => {
    setup();
    renderApp(<LeadsScreen />, '/leady');
    await screen.findByText('Alfa Przychodnia');
    fireEvent(window, new Event('offline'));
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    fireEvent(window, new Event('offline'));
    expect((await screen.findAllByRole('alert')).some((a) => /Brak połączenia z bazą/.test(a.textContent ?? ''))).toBe(true);
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });
});
