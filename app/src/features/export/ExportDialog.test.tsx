import '../../test/autocleanup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { exportRow } from '../../test/factories';
import { makeRpc, renderApp } from '../../test/render';

const rpcMock = vi.fn();
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), rpc: (...a: unknown[]) => rpcMock(...a) }));
const download = vi.fn();
vi.mock('../../lib/download', () => ({ downloadText: (...a: unknown[]) => download(...a) }));

import ExportDialog from './ExportDialog';

describe('ExportDialog', () => {
  beforeEach(() => { rpcMock.mockReset(); download.mockReset(); });

  function setup() {
    const rows = [
      exportRow({ id: 1, keyHash: '01', email: 'a@example.test' }),
      exportRow({ id: 2, keyHash: '02', email: 'a@example.test', qEmail: 10 }),
      exportRow({ id: 3, keyHash: '03', email: null }),
    ];
    const t = makeRpc({ export_begin: { exportId: 7, total: 3 }, export_page: rows, leads_count: { total: 4, email: 0, tel: 0, www: 0, nip: 0, mobile: 0 } });
    rpcMock.mockImplementation(t.fn);
    return t;
  }

  it('prepares a Customer.io file, reports skipped rows and downloads without BOM', async () => {
    const t = setup();
    renderApp(<ExportDialog target={{ entryIds: [1, 2, 3] }} count={3} label="Moja lista" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Przygotuj plik' }));
    const ok = (await screen.findByText(/Plik gotowy/)).parentElement!;
    expect(ok.textContent).toContain('Plik gotowy: 1 wiersz');
    expect(ok.textContent).toContain('nie kontaktować 4');
    expect(ok.textContent).toContain('brak e-maila 1');
    expect(ok.textContent).toContain('duplikaty e-maila 1');
    expect(t.calls.find((c) => c.name === 'export_begin')!.args).toMatchObject({ p_target: { entryIds: [1, 2, 3] }, p_format: 'customerio', p_options: { includeDnc: false, requireEmail: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Pobierz plik' }));
    const [text, name] = download.mock.calls[0] as [string, string];
    expect(name).toMatch(/^rpwzl-moja-lista-customerio-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(text.startsWith('id,email,created_at')).toBe(true);
  });

  it('builds a CSV with BOM, semicolon and the chosen columns', async () => {
    setup();
    renderApp(<ExportDialog target={{ filter: {} }} count={3} label="Wszystko" onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/CSV \(Excel\)/));
    fireEvent.click(screen.getByRole('button', { name: 'Przygotuj plik' }));
    await screen.findByText(/Plik gotowy/);
    fireEvent.click(screen.getByRole('button', { name: 'Pobierz plik' }));
    await waitFor(() => expect(download).toHaveBeenCalled());
    const [text] = download.mock.calls[0] as [string];
    expect(text.startsWith('﻿Nazwa;E-mail;Telefon;NIP;Miejscowość;')).toBe(true);
  });

  it('includes dnc leads only when ticked (sent to the server)', async () => {
    const t = setup();
    renderApp(<ExportDialog target={{ filter: {} }} count={3} label="x" onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/Uwzględnij leady oznaczone/));
    fireEvent.click(screen.getByRole('button', { name: 'Przygotuj plik' }));
    await screen.findByText(/Plik gotowy/);
    expect(t.calls.find((c) => c.name === 'export_begin')!.args.p_options).toMatchObject({ includeDnc: true });
    expect(t.calls.some((c) => c.name === 'leads_count')).toBe(false);
  });

  it('shows a Polish error when the server refuses', async () => {
    rpcMock.mockImplementation(() => Promise.reject(Object.assign(new Error('x'), { messagePl: 'Nie masz uprawnień do tej operacji.' })));
    renderApp(<ExportDialog target={{ filter: {} }} count={1} label="x" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Przygotuj plik' }));
    expect((await screen.findByRole('alert')).textContent).toBeTruthy();
  });
});
