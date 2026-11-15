import '../../test/autocleanup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { CrmError } from '../../lib/api';
import { renderApp } from '../../test/render';

const signIn = vi.fn();
let notice: string | null = null;
vi.mock('./AuthProvider', () => ({ useAuth: () => ({ signIn, notice }) }));
vi.mock('../../lib/supabase', () => ({ supabaseConfigured: true, supabase: {} }));

import LoginScreen from './LoginScreen';

describe('LoginScreen', () => {
  beforeEach(() => { signIn.mockReset(); notice = null; });

  it('signs in with the typed credentials', async () => {
    signIn.mockResolvedValue(undefined);
    renderApp(<LoginScreen />);
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ola@example.test' } });
    fireEvent.change(screen.getByLabelText('Hasło'), { target: { value: 'secret-pass-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zaloguj' }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith('ola@example.test', 'secret-pass-123'));
  });

  it('shows the Polish error from a failed sign-in', async () => {
    signIn.mockRejectedValue(new CrmError('UNKNOWN', 'Nieprawidłowy e-mail lub hasło.'));
    renderApp(<LoginScreen />);
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'a@example.test' } });
    fireEvent.change(screen.getByLabelText('Hasło'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zaloguj' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Nieprawidłowy e-mail lub hasło.');
  });

  it('shows the allowlist notice and the password hint', () => {
    notice = 'To konto nie ma dostępu do CRM. Poproś właściciela o dodanie Twojego adresu e-mail.';
    renderApp(<LoginScreen />);
    expect(screen.getByRole('alert').textContent).toContain('nie ma dostępu do CRM');
    fireEvent.click(screen.getByRole('button', { name: 'Nie pamiętasz hasła?' }));
    expect(screen.getByText(/ustawienie nowego hasła w panelu Supabase/)).toBeTruthy();
  });
});
