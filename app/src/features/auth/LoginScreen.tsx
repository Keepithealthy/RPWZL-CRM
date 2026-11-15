import { useState, type FormEvent } from 'react';
import { errorText } from '../../lib/api';
import { supabaseConfigured } from '../../lib/supabase';
import { useAuth } from './AuthProvider';

export default function LoginScreen() {
  const { signIn, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>RPWZL CRM</h1>
        <p className="muted">Zaloguj się, aby pracować na leadach z rejestru RPWDL.</p>
        {!supabaseConfigured ? (
          <div className="alert alert-error" role="alert">Brak konfiguracji: uzupełnij plik .env.local (zobacz .env.example) i uruchom aplikację ponownie.</div>
        ) : null}
        {notice ? <div className="alert alert-error" role="alert">{notice}</div> : null}
        {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
        <label className="field">
          <span className="field-label">E-mail</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Hasło</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !supabaseConfigured}>{busy ? 'Logowanie…' : 'Zaloguj'}</button>
        <button type="button" className="link" onClick={() => setForgot((v) => !v)}>Nie pamiętasz hasła?</button>
        {forgot ? <p className="hint">Poproś właściciela o ustawienie nowego hasła w panelu Supabase.</p> : null}
      </form>
    </main>
  );
}
