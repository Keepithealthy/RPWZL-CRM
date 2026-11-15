import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role, TeamMember } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { ErrorBox, Field, PageHeader, Spinner } from '../../components/common';
import { Modal } from '../../components/Modal';
import { useUi } from '../../components/ui';

export default function UsersScreen() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [dialog, setDialog] = useState<Partial<TeamMember> | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['members'], queryFn: () => rpc('members_list', {}) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['members'] }); void qc.invalidateQueries({ queryKey: ['ref'] }); };
  const toggle = useMutation({
    mutationFn: (m: TeamMember) => rpc('member_upsert', { p_member: { ...m, active: !m.active } }),
    onSuccess: () => { toast('Zapisano'); refresh(); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <div>
      <PageHeader title="Użytkownicy" help="Kto ma dostęp do CRM. Konto logowania zakładasz w panelu Supabase, tutaj nadajesz rolę i imię.">
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ role: 'member', active: true })}>Dodaj użytkownika</button>
      </PageHeader>
      {created ? <Steps email={created} onClose={() => setCreated(null)} /> : null}
      {q.isPending ? <Spinner /> : null}
      {q.isError ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data ? (
        <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>E-mail</th><th>Imię i nazwisko</th><th>Rola</th><th>Telefon</th><th>Aktywny</th><th>Ostatnio widziany</th><th>Edycja</th></tr></thead>
          <tbody>
            {q.data.map((m) => (
              <tr key={m.id}>
                <td>{m.email}</td><td>{m.displayName}</td><td>{m.role === 'owner' ? 'właściciel' : 'członek zespołu'}</td><td>{m.phone ?? '–'}</td>
                <td><input type="checkbox" checked={m.active} aria-label={`Aktywny: ${m.email}`} onChange={() => toggle.mutate(m)} /></td>
                <td>{m.hasLoggedIn ? fmtDateTime(m.lastSeenAt) : 'jeszcze nie logował(a) się'}</td>
                <td className="actions"><button type="button" className="link" onClick={() => setDialog(m)}>Edytuj</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : null}
      <p className="hint">Odebranie dostępu: odznacz „Aktywny” — działa od razu. Ostatniego właściciela nie da się usunąć ani zdegradować.</p>
      {dialog ? <MemberDialog initial={dialog} onClose={() => setDialog(null)} onSaved={(m, isNew) => { setDialog(null); refresh(); if (isNew) setCreated(m.email); }} /> : null}
    </div>
  );
}

function Steps({ email, onClose }: { email: string; onClose: () => void }) {
  return (
    <div className="alert alert-ok" role="status">
      <div>
        <strong>Dodano {email} do listy dostępu. Teraz dwa kroki w panelu Supabase:</strong>
        <ol>
          <li>Authentication → Users → „Add user” → „Create new user”: ten sam e-mail, hasło (min. 12 znaków), zaznacz „Auto Confirm User”.</li>
          <li>Przekaż hasło tej osobie osobnym kanałem (np. SMS-em), nie w tym samym e-mailu co adres CRM.</li>
        </ol>
        Bez kroku 1 ta osoba nie zaloguje się. Pełna instrukcja: docs/OPERATIONS.md.
      </div>
      <button type="button" className="btn btn-sm" onClick={onClose}>Rozumiem</button>
    </div>
  );
}

function MemberDialog({ initial, onClose, onSaved }: { initial: Partial<TeamMember>; onClose: () => void; onSaved: (m: TeamMember, isNew: boolean) => void }) {
  const isNew = !initial.id;
  const [email, setEmail] = useState(initial.email ?? '');
  const [name, setName] = useState(initial.displayName ?? '');
  const [role, setRole] = useState<Role>(initial.role ?? 'member');
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => rpc('member_upsert', { p_member: { ...initial, email: email.trim().toLowerCase(), displayName: name.trim(), role, phone: phone.trim() || null, active: initial.active ?? true } }),
    onSuccess: (r) => onSaved(r, isNew),
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal title={isNew ? 'Dodaj użytkownika' : 'Edytuj użytkownika'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Anuluj</button>
      <button type="button" className="btn btn-primary" disabled={!/^\S+@\S+\.\S+$/.test(email.trim()) || !name.trim() || m.isPending} onClick={() => m.mutate()}>Zapisz</button></>}>
      <Field label="E-mail (taki sam jak konto w Supabase)"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!isNew} autoFocus={isNew} /></Field>
      <Field label="Imię i nazwisko"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
      <Field label="Rola">
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}><option value="member">członek zespołu (pracuje na leadach)</option><option value="owner">właściciel (import, eksport, ustawienia)</option></select>
      </Field>
      <Field label="Telefon (pojawi się w szablonach jako {{opiekun_telefon}})"><input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></Field>
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
    </Modal>
  );
}
