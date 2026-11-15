import '../../test/autocleanup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { leadCard, me, refData } from '../../test/factories';
import { makeRpc, renderApp } from '../../test/render';

const rpcMock = vi.fn();
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), rpc: (...a: unknown[]) => rpcMock(...a) }));
vi.mock('../auth/AuthProvider', () => ({ useMe: () => me, useIsOwner: () => true }));

import { OutcomeDialog } from './OutcomeDialog';

function setup() {
  const t = makeRpc({
    ref_data: refData(),
    templates_list: [{ id: 1, kind: 'call', name: 'Skrypt A', subject: null, body: 'Dzień dobry, mówi {{ja}} z KIH. Rozmawiam z {{nazwa}}?', active: true, sort: 1, updatedAt: '' }],
    activity_add: { activityId: 1, row: {} },
    contact_upsert: {},
  });
  rpcMock.mockImplementation(t.fn);
  return t;
}
const call = (t: ReturnType<typeof setup>, name: string) => t.calls.find((c) => c.name === name);

describe('OutcomeDialog', () => {
  beforeEach(() => { rpcMock.mockReset(); });

  it('saves a call with outcome, note, next step and no unrelated side effects', async () => {
    const t = setup();
    renderApp(<OutcomeDialog card={leadCard()} initial={{ type: 'call', contactValue: '600 000 001' }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Poczta głosowa' }));
    fireEvent.change(screen.getByLabelText(/Notatka/), { target: { value: 'Zostawiono wiadomość' } });
    fireEvent.click(screen.getByRole('button', { name: 'za tydzień' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    await waitFor(() => expect(call(t, 'activity_add')).toBeTruthy());
    const a = call(t, 'activity_add')!.args as { p_entry_id: number; p_activity: Record<string, unknown> };
    expect(a.p_entry_id).toBe(1);
    expect(a.p_activity).toMatchObject({ type: 'call', outcome: 'poczta_glosowa', contactValue: '600 000 001', body: 'Zostawiono wiadomość' });
    expect(a.p_activity.nextStepAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a.p_activity).not.toHaveProperty('statusId');
    expect(a.p_activity).not.toHaveProperty('dnc');
    expect(a.p_activity).not.toHaveProperty('task');
    expect(call(t, 'contact_upsert')).toBeUndefined();
  });

  it('pre-ticks "nie kontaktować" for "Prosi o brak kontaktu" and sends dnc', async () => {
    const t = setup();
    renderApp(<OutcomeDialog card={leadCard()} initial={{ type: 'call', contactValue: '600 000 001' }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Prosi o brak kontaktu' }));
    expect((screen.getByLabelText('Oznacz: nie kontaktować') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    await waitFor(() => expect(call(t, 'activity_add')).toBeTruthy());
    expect((call(t, 'activity_add')!.args.p_activity as Record<string, unknown>).dnc).toBe(true);
  });

  it('offers to mark a wrong number and sends the override', async () => {
    const t = setup();
    renderApp(<OutcomeDialog card={leadCard()} initial={{ type: 'call', contactValue: '600 000 001' }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zły numer' }));
    fireEvent.click(screen.getByLabelText('Oznacz numer jako błędny'));
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    await waitFor(() => expect(call(t, 'contact_upsert')).toBeTruthy());
    expect(call(t, 'contact_upsert')!.args.p_contact).toMatchObject({ kind: 'phone', value: '600 000 001', status: 'invalid', source: 'register' });
  });

  it('suggests a next-step date for a paused status and can add a task', async () => {
    const t = setup();
    renderApp(<OutcomeDialog card={leadCard()} initial={{ type: 'note' }} onClose={() => {}} />);
    await screen.findByRole('option', { name: 'Nie teraz' });
    fireEvent.change(screen.getByLabelText('Nowy status'), { target: { value: '8' } });
    expect((screen.getByLabelText('Następny krok (data)') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    fireEvent.click(screen.getByLabelText('Dodaj zadanie'));
    fireEvent.change(screen.getByLabelText('Tytuł zadania'), { target: { value: 'Wrócić z ofertą' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    await waitFor(() => expect(call(t, 'activity_add')).toBeTruthy());
    expect(call(t, 'activity_add')!.args.p_activity).toMatchObject({ type: 'note', statusId: 8, task: { title: 'Wrócić z ofertą' } });
  });

  it('shows the call script with variables filled for calls', async () => {
    setup();
    renderApp(<OutcomeDialog card={leadCard()} initial={{ type: 'call' }} onClose={() => {}} />);
    expect(await screen.findByText(/Dzień dobry, mówi Ola Właścicielka z KIH\. Rozmawiam z Przychodnia Testowa Sp\. z o\.o\.\?/)).toBeTruthy();
  });

  it('shows the Polish error and keeps the dialog open when the save fails', async () => {
    const t = setup();
    rpcMock.mockImplementation((...c: unknown[]) => (c[0] === 'activity_add' ? Promise.reject(Object.assign(new Error('x'), { code: 'CR422', messagePl: 'Nieprawidłowe dane. Sprawdź formularz.' })) : t.fn(...c)));
    renderApp(<OutcomeDialog card={leadCard()} initial={{ type: 'note' }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
    expect((await screen.findByRole('alert')).textContent).toBeTruthy();
    expect(screen.getByText('Zapisz wynik kontaktu')).toBeTruthy();
  });
});
