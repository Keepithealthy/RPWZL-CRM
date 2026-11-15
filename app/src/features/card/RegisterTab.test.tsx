import '../../test/autocleanup';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { leadCard, leadRow, me } from '../../test/factories';
import { makeRpc, renderApp } from '../../test/render';
import type { LeadCard } from '../../lib/contract';

const rpcMock = vi.fn();
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), rpc: (...a: unknown[]) => rpcMock(...a) }));
vi.mock('../auth/AuthProvider', () => ({ useMe: () => me, useIsOwner: () => true }));

import { RegisterTab } from './RegisterTab';
import { zakresLabels } from './RegisterTab';

const podmiot = (): LeadCard => leadCard({
  row: leadRow({ nz: 2, nk: 2 }),
  rec: {
    emails: ['a@example.test'], phones: [], ulica: null, rodzaje: ['Ambulatoryjne świadczenia zdrowotne'], dz: ['Medycyna rodzinna'], fn: ['HC.1.3.3.'],
    d: {
      ks: '000000000001', zm: '2025-01-02', sie: 'ul. Próbna 1, 00-001 Testowo', tw: 'Podmiot Tworzący <b>x</b>', sc: [['Jan Testowy', '5260250995']], zx: 1,
      z: [
        { n: 'Zakład Pierwszy <script>alert(1)</script>', rg: '123456785', r: 0, a: 'ul. A 1', k: [{ n: 'Poradnia POZ', s: '0001', dz: [0], fn: [0], lo: 4 }], j: [] },
        { n: 'Zakład Drugi', k: [{ n: 'Komórka ukryta do otwarcia' }], j: [] },
      ],
    },
  },
});

describe('RegisterTab', () => {
  it('renders register text as text only (no HTML injection)', () => {
    rpcMock.mockImplementation(makeRpc({ dict: [{ facet: 'p.spec', val: '0001', label: '0001 — Medycyna rodzinna' }] }).fn);
    const { container } = renderApp(<RegisterTab card={podmiot()} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText(/Zakład Pierwszy <script>alert\(1\)<\/script>/)).toBeTruthy();
    expect(screen.getByText(/Podmiot Tworzący <b>x<\/b>/)).toBeTruthy();
  });

  it('opens the first zakład and renders komórki lazily for the others', async () => {
    rpcMock.mockImplementation(makeRpc({ dict: [{ facet: 'p.spec', val: '0001', label: '0001 — Medycyna rodzinna' }, { facet: 'p.fn', val: 'HC.1.3.3.', label: 'Podstawowa opieka' }] }).fn);
    renderApp(<RegisterTab card={podmiot()} />);
    expect(screen.getByText('Poradnia POZ')).toBeTruthy();
    expect(await screen.findByText(/0001 — Medycyna rodzinna/)).toBeTruthy();
    expect(screen.getByText(/dziedziny: Medycyna rodzinna/)).toBeTruthy();
    expect(screen.getByText(/łóżka: 4/)).toBeTruthy();
    expect(screen.queryByText('Komórka ukryta do otwarcia')).toBeNull();
    expect(screen.getByText(/oraz 1 nieaktywnych/)).toBeTruthy();
    expect(screen.getByText(/Jan Testowy — NIP 5260250995/)).toBeTruthy();
  });

  it('falls back gracefully when there is no detail', () => {
    rpcMock.mockImplementation(makeRpc({ dict: [] }).fn);
    renderApp(<RegisterTab card={leadCard({ rec: null })} />);
    expect(screen.getByText(/Brak szczegółów w bazie/)).toBeTruthy();
    expect(screen.getByText(/numerze księgi 000000000001/)).toBeTruthy();
  });

  it('renders a practice: person, activities with zakres labels and partners', () => {
    rpcMock.mockImplementation(makeRpc({ dict: [] }).fn);
    const card = leadCard({
      row: leadRow({ kind: 'r', src: 'Rpzg', entityType: 5 }),
      facets: { 'r.gz': ['lekarz'] },
      rec: { phones: [], ulica: null, rodzaj: ['Grupowa praktyka lekarska'], rd: ['Ambulatoryjne'], d: {
        ks: '1', tyt: 'lek.', npwz: '1234567', sp: [['Choroby wewnętrzne', 'II stopień']],
        a: [{ t: 0, ta: 0, dz: ['Interna'], zk: 3, ad: [[0, 'ul. X 1', '600 000 001'], [2, null, '22 000 00 02', 'Zakład Y', '123']] }],
        w: [{ n: 'Anna Wspólnik', nip: '5260250995', gz: 'lekarz', npwz: '7654321', a: [] }],
        zw: [['2024-01-01', null]],
      } },
    });
    renderApp(<RegisterTab card={card} />);
    expect(screen.getByText('1234567')).toBeTruthy();
    expect(screen.getByText('Choroby wewnętrzne (II stopień)')).toBeTruthy();
    expect(screen.getByText('Diagnostyczny, Leczniczy')).toBeTruthy();
    expect(screen.getByText('Miejsce udzielania świadczeń')).toBeTruthy();
    expect(screen.getByText(/Zakład Y, REGON 123/)).toBeTruthy();
    expect(screen.getByText('Anna Wspólnik')).toBeTruthy();
    expect(screen.getByText(/bezterminowo/)).toBeTruthy();
  });

  it('decodes the zakres bitmask', () => {
    expect(zakresLabels(0)).toEqual([]);
    expect(zakresLabels(1 | 4 | 1024)).toEqual(['Diagnostyczny', 'Rehabilitacyjny', 'Opinie i orzeczenia z medycyny laboratoryjnej']);
  });
});
