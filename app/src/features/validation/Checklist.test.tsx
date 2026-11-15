import '../../test/autocleanup';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QFLAG, VALIDATION } from '../../lib/contract';
import { makeRpc, renderApp } from '../../test/render';

const holder: { fn: (name: string, args: Record<string, unknown>) => Promise<unknown> } = { fn: () => Promise.reject(new Error('no rpc')) };
vi.mock('../../lib/api', async (orig) => {
  const real = await orig<typeof import('../../lib/api')>();
  return { ...real, rpc: (name: string, args: Record<string, unknown>) => holder.fn(name, args) };
});

import { ChecklistEditor, ValidationReasons, ValidationStatusBadge, checklistStateFrom, suggestStatus, validationReasons } from './Checklist';

describe('suggestStatus', () => {
  it('suggests "Zweryfikowany" only when the first three answers are yes', () => {
    expect(suggestStatus({ podmiotDziala: true, profilPasuje: true, telefonOk: true })).toBe(VALIDATION.ZWERYFIKOWANY);
    expect(suggestStatus({ podmiotDziala: true, profilPasuje: true, telefonOk: null })).toBeNull();
    expect(suggestStatus({ podmiotDziala: true, profilPasuje: false, telefonOk: true })).toBeNull();
    expect(suggestStatus({})).toBeNull();
    expect(suggestStatus(null)).toBeNull();
  });
  it('suggests "Odrzucony" when the entity does not exist', () => {
    expect(suggestStatus({ podmiotDziala: false })).toBe(VALIDATION.ODRZUCONY);
  });
});

describe('reasons and badge', () => {
  it('lists only the problem bits as reasons', () => {
    expect(validationReasons(QFLAG.STALE | QFLAG.EMAIL_FREE)).toEqual([]);
    expect(validationReasons(QFLAG.NIP_CHECKSUM | QFLAG.STALE)).toEqual(['NIP z błędną sumą kontrolną']);
  });
  it('renders the derived status in italics', () => {
    renderApp(<><ValidationStatusBadge status={1} derived /><ValidationStatusBadge status={2} /><ValidationReasons qflags={QFLAG.NO_CONTACT} /></>);
    expect(screen.getByText('Do sprawdzenia').tagName).toBe('EM');
    expect(screen.getByText('Zweryfikowany').tagName).not.toBe('EM');
    expect(screen.getByText('brak działającego kontaktu')).toBeTruthy();
  });
});

describe('ChecklistEditor', () => {
  it('proposes a status from the checklist and saves checklist, status and note in one lead_update', async () => {
    const { fn, calls } = makeRpc({ lead_update: (a: Record<string, unknown>) => ({ id: a.p_entry_id, version: 4 }) });
    holder.fn = (n, a) => fn(n, a) as Promise<unknown>;
    const onSaved = vi.fn();
    renderApp(<ChecklistEditor entryId={12} version={3} onSaved={onSaved} initial={checklistStateFrom({ validation: 0, validationIsDerived: true }, null)} />);
    expect((screen.getByLabelText('Status walidacji') as HTMLSelectElement).value).toBe('auto');
    for (const label of ['Podmiot istnieje i działa pod tym adresem', 'Profil pasuje do naszej oferty', 'Telefon działa i należy do tego podmiotu']) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: 'tak' } });
    }
    expect(screen.getByText(/proponujemy status „Zweryfikowany”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ustaw' }));
    fireEvent.change(screen.getByLabelText('Osoba decyzyjna (imię, stanowisko)'), { target: { value: 'Jan, dyrektor' } });
    fireEvent.change(screen.getByLabelText('Notatka do statusu'), { target: { value: ' potwierdzone telefonicznie ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz walidację' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const call = calls.find((c) => c.name === 'lead_update')!;
    expect(call.args).toMatchObject({
      p_entry_id: 12, p_version: 3,
      p_patch: { validation: 2, validationNote: 'potwierdzone telefonicznie', checklist: { podmiotDziala: true, profilPasuje: true, telefonOk: true, decydent: 'Jan, dyrektor' } },
    });
  });

  it('"Automatyczny" sends validation: null (back to derived)', async () => {
    const { fn, calls } = makeRpc({ lead_update: { id: 1, version: 2 } });
    holder.fn = (n, a) => fn(n, a) as Promise<unknown>;
    renderApp(<ChecklistEditor entryId={1} version={1} initial={checklistStateFrom({ validation: 2, validationIsDerived: false }, { checklist: { uwagi: 'x' }, validationNote: null })} />);
    expect((screen.getByLabelText('Status walidacji') as HTMLSelectElement).value).toBe('2');
    fireEvent.change(screen.getByLabelText('Status walidacji'), { target: { value: 'auto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz walidację' }));
    await waitFor(() => expect(calls.some((c) => c.name === 'lead_update')).toBe(true));
    expect(calls[0]!.args).toMatchObject({ p_patch: { validation: null, checklist: { uwagi: 'x' } } });
  });
});
