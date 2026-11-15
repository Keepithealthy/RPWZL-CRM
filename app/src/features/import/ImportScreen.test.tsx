import '../../test/autocleanup';
import { File as NodeFile } from 'node:buffer';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render';
import { buildIndex, standardDataset } from './fixtures';
import { fakeDb } from './test-utils';

const holder: { rpc: (name: string, args: Record<string, unknown>) => Promise<unknown> } = { rpc: () => Promise.reject(new Error('no db')) };

vi.mock('../../lib/api', async (orig) => {
  const real = await orig<typeof import('../../lib/api')>();
  return { ...real, rpc: (name: string, args: Record<string, unknown>) => holder.rpc(name, args) };
});
vi.mock('./backend', async (orig) => {
  const real = await orig<typeof import('./backend')>();
  return { ...real, createBackend: () => new real.LocalBackend() };
});

import ImportScreen from './ImportScreen';

const pick = (text: string, name = 'rpwdl-index-2026-11-14.json.gz') => {
  const input = screen.getByLabelText('Plik indeksu rejestru') as HTMLInputElement;
  const file = new NodeFile([text], name);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
};

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});

describe('ImportScreen', () => {
  it('explains the file, refuses a v1 index with the contract message', async () => {
    holder.rpc = fakeDb().rpc as never;
    renderApp(<ImportScreen />);
    expect(screen.getByText(/Wybierz plik indeksu/)).toBeTruthy();
    const { p, r } = standardDataset();
    pick(buildIndex({ p, r, version: 1 }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('wersji 1'));
    expect(screen.getByLabelText('Plik indeksu rejestru')).toBeTruthy();
  });

  it('shows the preview, requires no tick when there is no warning, imports and shows the summary', async () => {
    const db = fakeDb();
    holder.rpc = db.rpc as never;
    renderApp(<ImportScreen />);
    const { p, r } = standardDataset();
    pick(buildIndex({ p, r }));
    await screen.findByRole('heading', { name: 'Co się zmieni' });
    const table = screen.getByRole('table', { name: 'Podsumowanie zmian' });
    const newRow = within(table).getByText('Nowe wpisy').closest('tr') as HTMLElement;
    expect(newRow.textContent).toContain(String(p.length + r.length));
    expect(screen.getByText(/Import nigdy nie zmienia statusów/)).toBeTruthy();
    expect(db.entries.size).toBe(0); // nothing is written before the owner confirms
    fireEvent.click(screen.getByRole('button', { name: 'Zatwierdź import' }));
    await screen.findByRole('heading', { name: 'Import zakończony' });
    expect(db.entries.size).toBe(p.length + r.length);
    expect(screen.getByRole('button', { name: 'Zobacz zmiany' })).toBeTruthy();
  });

  it('keeps "Zatwierdź import" disabled until every warning is ticked', async () => {
    const { p, r } = standardDataset();
    const db = fakeDb({
      runs: [{ id: 1, status: 'applied', fileName: 'x', reportDate: '2026-12-01', startedAt: '', finishedAt: '2026-12-01T00:00:00Z', startedBy: 1, counts: null, error: null }],
    });
    holder.rpc = db.rpc as never;
    renderApp(<ImportScreen />);
    pick(buildIndex({ p, r }));
    await screen.findByRole('heading', { name: 'Co się zmieni' });
    const confirm = screen.getByRole('button', { name: 'Zatwierdź import' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirm.disabled).toBe(false);
  });

  it('blocks the import when the database is above 450 MB', async () => {
    const { p, r } = standardDataset();
    holder.rpc = fakeDb({ bytes: 470 * 1024 * 1024 }).rpc as never;
    renderApp(<ImportScreen />);
    pick(buildIndex({ p, r }));
    await screen.findByRole('heading', { name: 'Co się zmieni' });
    expect((screen.getByRole('button', { name: 'Zatwierdź import' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('alert')[0]!.textContent).toContain('470 MB');
  });

  it('offers to close an interrupted run remembered from a previous visit', async () => {
    localStorage.setItem('rpwzl.import.run', JSON.stringify({ runId: 5, fileName: 'stary.json.gz', startedAt: new Date().toISOString() }));
    const db = fakeDb();
    holder.rpc = db.rpc as never;
    renderApp(<ImportScreen />);
    expect(screen.getByText(/nie został dokończony/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zamknij przerwany import' }));
    await waitFor(() => expect(db.log).toContain('import_abort'));
    await waitFor(() => expect(screen.queryByText(/nie został dokończony/)).toBeNull());
    expect(localStorage.getItem('rpwzl.import.run')).toBeNull();
  });
});
