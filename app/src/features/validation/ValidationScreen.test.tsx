import '../../test/autocleanup';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeadRow, ProposalDetail, ProposalSummary } from '../../lib/contract';
import { makeRpc, renderApp } from '../../test/render';

const holder: { fn: (name: string, args: Record<string, unknown>) => Promise<unknown> } = { fn: () => Promise.reject(new Error('no rpc')) };
vi.mock('../../lib/api', async (orig) => {
  const real = await orig<typeof import('../../lib/api')>();
  return { ...real, rpc: (name: string, args: Record<string, unknown>) => holder.fn(name, args) };
});

import ValidationScreen from './ValidationScreen';

const row = (id: number, o: Partial<LeadRow>): LeadRow => ({
  id, kind: 'p', src: 'Rpm', name: `Wpis ${id}`, nip: '1234567890', email: null, tel: null, miasto: 'Testowo', woj: 'testowe', inRegister: true, entityType: 1,
  qflags: 0, accountKey: 'n:1234567890', accountSize: 1, ...o,
}) as LeadRow;

const prop = (id: number, kind: ProposalSummary['kind'], members: string[], extra: Partial<ProposalSummary> = {}): ProposalSummary => ({
  id, kind, matchValue: kind === 'email' ? 'wspolny@firma.pl' : 'n:1234567890', confidence: 85, groupKey: 'g' + id, status: 0, members, newMembers: [], decidedBy: null, decidedAt: null, note: null, networkId: null, ...extra,
});

function setup(opts: { accounts?: ProposalSummary[]; networks?: ProposalSummary[]; details?: Record<number, LeadRow[]> } = {}) {
  const accounts = opts.accounts ?? [];
  const networks = opts.networks ?? [];
  const { fn, calls } = makeRpc({
    ref_data: { me: { memberId: 1, role: 'owner' }, members: [], statuses: [], tags: [], views: [{ id: 3, name: 'POZ', scope: 'system', filter: { kind: 'p' } }], lists: [], lastImport: null, settings: {} },
    val_summary: { queues: { accounts: { open: accounts.length, decided: 0 }, networks: { open: networks.length, decided: 0 }, records: { open: 0, decided: 0 } }, byKind: {}, records: { doSprawdzenia: 7, zweryfikowany: 0, odrzucony: 0, niezweryfikowany: 0 } },
    val_queue: (a: Record<string, unknown>) => (a.p_queue === 'accounts' ? accounts : networks),
    val_proposal_get: (a: Record<string, unknown>) => {
      const id = a.p_id as number;
      const all = [...accounts, ...networks];
      const p = all.find((x) => x.id === id)!;
      return { ...p, entries: opts.details?.[id] ?? [] } satisfies ProposalDetail;
    },
    networks_list: [{ id: 9, name: 'Sieć Zdrowie', note: null, accounts: 3, entries: 4, createdAt: '2026-01-01' }],
    val_decide: (a: Record<string, unknown>) => ({ ...(([...accounts, ...networks].find((x) => x.id === a.p_id)) as ProposalSummary), networkId: 5 }),
    val_account_link: [],
    leads_count: { total: 7 },
    leads_search: { rows: [row(70, { qflags: 8, name: 'Zły NIP sp. z o.o.' })] },
  });
  holder.fn = (n, a) => fn(n, a) as Promise<unknown>;
  return calls;
}

beforeEach(() => { holder.fn = () => Promise.reject(new Error('no rpc')); });

describe('ValidationScreen', () => {
  it('shows the purpose line, counters on the tabs and the segment selector', async () => {
    setup({ accounts: [prop(1, 'account_check', ['n:1234567890'])], networks: [prop(2, 'email', ['n:1', 'n:2']), prop(3, 'domain', ['n:1', 'n:2'])] });
    renderApp(<ValidationScreen />);
    expect(screen.getByText(/Tu potwierdzasz, kto jest kim/)).toBeTruthy();
    await screen.findByRole('tab', { name: 'Konta (1)' });
    expect(screen.getByRole('tab', { name: 'Sieci i duplikaty (2)' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Rekordy do sprawdzenia (7)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'POZ' })).toBeTruthy();
  });

  it('groups network proposals with identical members into one card with combined confidence', async () => {
    setup({ networks: [prop(2, 'email', ['n:1', 'n:2'], { groupKey: 'same' }), prop(3, 'domain', ['n:1', 'n:2'], { groupKey: 'same', confidence: 70 })] });
    renderApp(<ValidationScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: /Sieci i duplikaty/ }));
    const cards = await screen.findAllByRole('article');
    expect(cards).toHaveLength(1);
    expect(within(cards[0]!).getByText(/pewność 90/)).toBeTruthy();
    expect(within(cards[0]!).getByText(/Ten sam adres e-mail/)).toBeTruthy();
    expect(within(cards[0]!).getByText(/Ta sama domena e-mail/)).toBeTruthy();
  });

  it('rejecting an account_check warns which entries the server will split out and sends only the decision', async () => {
    const entries = [row(1, { entityType: 1, name: 'Spółka Test' }), row(2, { entityType: 4, kind: 'r', name: 'Gabinet Test' }), row(3, { entityType: 5, kind: 'r', name: 'Grupa Test' })];
    const calls = setup({ accounts: [prop(1, 'account_check', ['n:1234567890'])], details: { 1: entries } });
    renderApp(<ValidationScreen />);
    await screen.findByRole('link', { name: 'Spółka Test' }); // the first card is active and shows its entries
    expect(screen.getByText(/rozdzieli konto/).textContent).toContain('Spółka Test');
    fireEvent.click(screen.getByRole('button', { name: /To różne podmioty/ }));
    await waitFor(() => expect(calls.some((c) => c.name === 'val_decide')).toBe(true));
    // the database does the split inside val_decide (CONTRACT Deviations 10): no separate val_account_link call
    expect(calls.filter((c) => c.name === 'val_account_link')).toHaveLength(0);
    expect(calls.find((c) => c.name === 'val_decide')!.args).toMatchObject({ p_id: 1, p_decision: { decision: 'reject' } });
  });

  it('confirming a network opens the dialog with the largest member as default name and sends the chosen members', async () => {
    const entries = [row(1, { accountKey: 'n:1', name: 'Przychodnia Alfa' }), row(2, { accountKey: 'n:2', name: 'Przychodnia Beta' }), row(3, { accountKey: 'n:2', kind: 'r', name: 'Gabinet Beta' }), row(4, { accountKey: 'n:3', name: 'Inna' })];
    const calls = setup({
      networks: [prop(2, 'email', ['n:1', 'n:2', 'n:3'], { groupKey: 'same' }), prop(3, 'www', ['n:1', 'n:2', 'n:3'], { groupKey: 'same', confidence: 80 })],
      details: { 2: entries, 3: entries },
    });
    renderApp(<ValidationScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: /Sieci i duplikaty/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Potwierdź sieć/ }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Nazwa sieci') as HTMLInputElement).value).toBe('Przychodnia Beta');
    fireEvent.click(within(dialog).getByLabelText(/Inna/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zapisz sieć' }));
    await waitFor(() => expect(calls.filter((c) => c.name === 'val_decide')).toHaveLength(2));
    const d = calls.filter((c) => c.name === 'val_decide');
    expect(d[0]!.args).toMatchObject({ p_id: 2, p_decision: { decision: 'accept', newNetworkName: 'Przychodnia Beta', memberKeys: ['n:1', 'n:2'] } });
    // the second proposal joins the network the first one created
    expect(d[1]!.args).toMatchObject({ p_id: 3, p_decision: { decision: 'accept', networkId: 5, memberKeys: ['n:1', 'n:2'] } });
  });

  it('keyboard: J moves to the next card, N rejects the active one, L postpones it', async () => {
    const calls = setup({ networks: [prop(2, 'email', ['n:1', 'n:2']), prop(3, 'email', ['n:3', 'n:4'], { matchValue: 'drugi@firma.pl', confidence: 70 })] });
    renderApp(<ValidationScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: /Sieci i duplikaty/ }));
    await screen.findAllByRole('article');
    fireEvent.keyDown(window, { key: 'j' });
    await waitFor(() => expect(screen.getAllByRole('article')[1]!.className).toContain('active'));
    fireEvent.keyDown(window, { key: 'n' });
    await waitFor(() => expect(calls.find((c) => c.name === 'val_decide')?.args).toMatchObject({ p_id: 3, p_decision: { decision: 'reject' } }));
    fireEvent.keyDown(window, { key: 'l' });
    await waitFor(() => expect(screen.getAllByRole('article').some((a) => a.className.includes('skipped'))).toBe(true));
    // the postponed card sinks to the end and the other one becomes active
    expect(screen.getAllByRole('article')[0]!.className).toContain('active');
  });

  it('ignores shortcuts while typing in a field', async () => {
    const calls = setup({ networks: [prop(2, 'email', ['n:1', 'n:2'])] });
    renderApp(<ValidationScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: /Sieci i duplikaty/ }));
    await screen.findAllByRole('article');
    const select = screen.getByLabelText('Pokaż tylko propozycje dla widoku');
    fireEvent.keyDown(select, { key: 'n' });
    expect(calls.some((c) => c.name === 'val_decide')).toBe(false);
  });

  it('decided proposals can be reopened', async () => {
    const calls = setup({ accounts: [prop(1, 'account_check', ['n:1234567890'], { status: 2, decidedAt: '2026-11-01T10:00:00Z' })] });
    renderApp(<ValidationScreen />);
    fireEvent.change(await screen.findByLabelText('Pokaż'), { target: { value: '2' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Cofnij decyzję' }));
    await waitFor(() => expect(calls.find((c) => c.name === 'val_decide')?.args).toMatchObject({ p_decision: { decision: 'reopen' } }));
  });

  it('records queue lists leads to check with their problems and links to the contact tab', async () => {
    setup({});
    renderApp(<ValidationScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: /Rekordy do sprawdzenia/ }));
    const link = await screen.findByRole('link', { name: 'Zły NIP sp. z o.o.' });
    expect(link.getAttribute('href')).toBe('/lead/70?tab=kontakt');
    expect(screen.getByText('NIP z błędną sumą kontrolną')).toBeTruthy();
  });
});
