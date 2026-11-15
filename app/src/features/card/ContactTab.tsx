import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { LeadCard, LeadContact } from '../../lib/contract';
import { QFLAG } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { copyText } from '../../lib/links';
import { fmtDate } from '../../lib/format';
import { qualityLabel } from '../leads/columns';
import { Badge } from '../../components/common';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/common';
import { useUi } from '../../components/ui';
import { collectEmails, collectPhones, type EmailItem, type PhoneItem } from './contacts';
import { invalidateLead } from './hooks';

interface Props { card: LeadCard; onCall: (raw: string) => void; onCompose: (kind: 'sms' | 'email', to: string) => void }

function wwwHref(www: string): string | null {
  const host = www.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host}` : null;
}

export function ContactTab({ card, onCall, onCompose }: Props) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [adding, setAdding] = useState(false);
  const phones = collectPhones(card);
  const emails = collectEmails(card);
  const people = card.contacts.filter((c) => c.kind === 'person');
  const crmWww = card.contacts.filter((c) => c.kind === 'www' && c.source === 'crm');
  const q = card.row.qflags;
  const stale = (q & QFLAG.STALE) !== 0;

  const upsert = useMutation({
    mutationFn: (c: Partial<LeadContact> & Pick<LeadContact, 'kind'>) => rpc('contact_upsert', { p_entry_id: card.row.id, p_contact: c }),
    onSuccess: () => { toast('Zapisano'); invalidateLead(qc, card.row.id); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const del = useMutation({
    mutationFn: (id: number) => rpc('contact_delete', { p_id: id }),
    onSuccess: () => { toast('Usunięto kontakt'); invalidateLead(qc, card.row.id); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const copy = async (v: string) => toast((await copyText(v)) ? 'Skopiowano' : 'Nie udało się skopiować', 'ok');

  const emailReasons = [
    q & QFLAG.EMAIL_FREE ? 'darmowa skrzynka' : null, q & QFLAG.EMAIL_ROLE ? 'adres recepcji / biura' : null,
    q & QFLAG.EMAIL_TYPO ? 'możliwa literówka w domenie' : null, q & QFLAG.EMAIL_SHARED ? 'ten sam adres mają inne konta' : null,
    q & QFLAG.EMAIL_INVALID ? 'zły format' : null,
  ].filter(Boolean).join(', ');

  const emailAct = (e: EmailItem) => (
    <span className="actions">
      <button type="button" className="link" onClick={() => void copy(e.value)}>Kopiuj</button>
      <button type="button" className="link" onClick={() => onCompose('email', e.value)}>E-mail</button>
      {!e.primary && !e.invalid ? <button type="button" className="link" onClick={() => upsert.mutate({ id: e.contactId ?? undefined, kind: 'email', value: e.value, source: e.source, status: 'ok', isPrimary: true })}>Ustaw jako główny</button> : null}
      {e.invalid ? <button type="button" className="link" onClick={() => upsert.mutate({ id: e.contactId ?? undefined, kind: 'email', value: e.value, source: e.source, status: 'unknown' })}>Przywróć</button>
        : <button type="button" className="link" onClick={() => upsert.mutate({ id: e.contactId ?? undefined, kind: 'email', value: e.value, source: e.source, status: 'invalid', isPrimary: false })}>Oznacz jako błędny</button>}
      {e.source === 'crm' && e.contactId ? <button type="button" className="link" onClick={() => del.mutate(e.contactId!)}>Usuń</button> : null}
    </span>
  );
  const phoneAct = (p: PhoneItem) => (
    <span className="actions">
      <button type="button" className="link" onClick={() => void copy(p.raw)}>Kopiuj</button>
      <button type="button" className="link" onClick={() => onCall(p.raw)}>Zadzwoń</button>
      {p.mobile ? <button type="button" className="link" onClick={() => onCompose('sms', p.raw)}>SMS</button> : null}
      {!p.primary && !p.invalid ? <button type="button" className="link" onClick={() => upsert.mutate({ id: p.contactId ?? undefined, kind: 'phone', value: p.raw, source: p.source, status: 'ok', isPrimary: true })}>Ustaw jako główny</button> : null}
      {p.invalid ? <button type="button" className="link" onClick={() => upsert.mutate({ id: p.contactId ?? undefined, kind: 'phone', value: p.raw, source: p.source, status: 'unknown' })}>Przywróć</button>
        : <button type="button" className="link" onClick={() => upsert.mutate({ id: p.contactId ?? undefined, kind: 'phone', value: p.raw, source: p.source, status: 'invalid', isPrimary: false })}>Oznacz jako błędny</button>}
      {p.source === 'crm' && p.contactId ? <button type="button" className="link" onClick={() => del.mutate(p.contactId!)}>Usuń</button> : null}
    </span>
  );

  return (
    <div className="contact-tab">
      <p className="hint">
        Dane kontaktowe z rejestru, ostatnia zmiana wpisu: {fmtDate(card.row.stan)}
        {stale ? ' — brak zmian od migracji rejestru 10.11.2023, dane mogą być nieaktualne.' : '.'}
      </p>

      <h3>E-maile</h3>
      {emails.length === 0 ? <p className="muted">Brak adresu e-mail. Telefon lub dodanie kontaktu poniżej.</p> : (
        <ul className="clist">
          {emails.map((e) => (
            <li key={e.value} className={e.invalid ? 'invalid' : undefined}>
              <span className="val">{e.value}</span>
              {e.primary ? <Badge tone="blue">główny</Badge> : null}
              {e.source === 'crm' ? <Badge>dodany w CRM</Badge> : null}
              {e.invalid ? <Badge tone="red">błędny</Badge> : null}
              {e.primary && card.row.qEmail !== null ? <Badge tone={card.row.qEmail >= 70 ? 'green' : card.row.qEmail >= 40 ? 'yellow' : 'red'}>{qualityLabel(card.row.qEmail)}</Badge> : null}
              {e.primary && emailReasons ? <span className="muted"> {emailReasons}</span> : null}
              {emailAct(e)}
            </li>
          ))}
        </ul>
      )}

      <h3>Telefony</h3>
      {phones.length === 0 ? <p className="muted">Brak telefonu.</p> : (
        <ul className="clist">
          {phones.map((p) => (
            <li key={p.raw} className={p.invalid ? 'invalid' : undefined}>
              <span className="val">{p.raw}</span>
              {p.primary ? <Badge tone="blue">główny</Badge> : null}
              {p.nine ? <Badge>{p.mobile ? 'komórkowy' : 'stacjonarny / inny'}</Badge> : <Badge tone="yellow">nie do wybrania</Badge>}
              {p.sharedWith > 1 ? <Badge tone="yellow" title="Ten numer jest w wielu kontach — to może być centrala">wspólny z {p.sharedWith} kontami</Badge> : null}
              {p.primary && q & QFLAG.PHONE_SWITCHBOARD ? <Badge tone="yellow">prawdopodobnie centrala</Badge> : null}
              {p.source === 'crm' ? <Badge>dodany w CRM</Badge> : null}
              {p.invalid ? <Badge tone="red">błędny</Badge> : null}
              {!p.nine ? <span className="muted"> Numer może być niepełny</span> : null}
              {phoneAct(p)}
            </li>
          ))}
        </ul>
      )}

      <h3>Strona WWW</h3>
      {[card.row.www, ...crmWww.map((c) => c.value)].filter((w): w is string => Boolean(w)).length === 0 ? <p className="muted">Brak strony www.</p> : (
        <ul className="clist">
          {[...new Set([card.row.www, ...crmWww.map((c) => c.value)].filter((w): w is string => Boolean(w)))].map((w) => {
            const href = wwwHref(w);
            return (
              <li key={w}>
                {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="val">{w}</a> : <span className="val">{w}</span>}
                {q & QFLAG.WWW_SOCIAL ? <Badge tone="yellow">profil społecznościowy</Badge> : null}
                {q & QFLAG.WWW_INVALID ? <Badge tone="red">zły format</Badge> : null}
                <span className="actions"><button type="button" className="link" onClick={() => void copy(w)}>Kopiuj</button></span>
              </li>
            );
          })}
        </ul>
      )}

      <h3>Osoby kontaktowe</h3>
      {people.length === 0 ? <p className="muted">Nie dodano jeszcze osób. Wpisz imię i stanowisko osoby, z którą rozmawiasz.</p> : (
        <ul className="clist">
          {people.map((c) => (
            <li key={c.id}><span className="val">{c.personName}</span>{c.personRole ? <span className="muted"> — {c.personRole}</span> : null}{c.value ? <span> · {c.value}</span> : null}{c.note ? <span className="muted"> · {c.note}</span> : null}
              <span className="actions"><button type="button" className="link" onClick={() => del.mutate(c.id)}>Usuń</button></span></li>
          ))}
        </ul>
      )}
      <button type="button" className="btn" onClick={() => setAdding(true)}>Dodaj kontakt</button>
      {adding ? <AddContactDialog onClose={() => setAdding(false)} onSave={(c) => upsert.mutate(c, { onSuccess: () => setAdding(false) })} saving={upsert.isPending} /> : null}
    </div>
  );
}

function AddContactDialog({ onClose, onSave, saving }: { onClose: () => void; onSave: (c: Partial<LeadContact> & Pick<LeadContact, 'kind'>) => void; saving: boolean }) {
  const [kind, setKind] = useState<LeadContact['kind']>('phone');
  const [value, setValue] = useState('');
  const [person, setPerson] = useState('');
  const [role, setRole] = useState('');
  const [note, setNote] = useState('');
  const valid = kind === 'person' ? Boolean(person.trim()) : Boolean(value.trim());
  return (
    <Modal title="Dodaj kontakt" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Anuluj</button>
      <button type="button" className="btn btn-primary" disabled={!valid || saving} onClick={() => onSave({ kind, value: value.trim() || null, personName: kind === 'person' ? person.trim() : null, personRole: kind === 'person' ? role.trim() || null : null, note: note.trim() || null, source: 'crm', status: 'ok' })}>Zapisz</button></>}>
      <Field label="Rodzaj">
        <select value={kind} onChange={(e) => setKind(e.target.value as LeadContact['kind'])}>
          <option value="phone">Telefon</option><option value="email">E-mail</option><option value="www">Strona www</option><option value="person">Osoba</option>
        </select>
      </Field>
      {kind === 'person' ? (
        <>
          <Field label="Imię i nazwisko"><input value={person} onChange={(e) => setPerson(e.target.value)} autoFocus /></Field>
          <Field label="Stanowisko"><input value={role} onChange={(e) => setRole(e.target.value)} /></Field>
          <Field label="Telefon lub e-mail osoby"><input value={value} onChange={(e) => setValue(e.target.value)} /></Field>
        </>
      ) : <Field label={kind === 'phone' ? 'Numer telefonu' : kind === 'email' ? 'Adres e-mail' : 'Adres strony'}><input value={value} onChange={(e) => setValue(e.target.value)} autoFocus /></Field>}
      <Field label="Notatka"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
    </Modal>
  );
}
