import { useState } from 'react';
import { VALIDATION, VALIDATION_PL, type LeadCard, type ValidationChecklist, type ValidationStatus } from '../../lib/contract';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/common';
import { useLeadPatch } from './hooks';

type Tri = boolean | null | undefined;
const triValue = (v: Tri) => (v === true ? 'tak' : v === false ? 'nie' : '');
const fromTri = (s: string): boolean | null => (s === 'tak' ? true : s === 'nie' ? false : null);

/** Checklist the team fills after a call (SPEC 6.7) plus the validation status it leads to. */
export function ChecklistDialog({ card, onClose }: { card: LeadCard; onClose: () => void }) {
  const patch = useLeadPatch(card);
  const [c, setC] = useState<ValidationChecklist>(card.lead?.checklist ?? {});
  const [status, setStatus] = useState<ValidationStatus>(card.row.validation === VALIDATION.NIEZWERYFIKOWANY ? VALIDATION.ZWERYFIKOWANY : card.row.validation);
  const [note, setNote] = useState(card.lead?.validationNote ?? '');

  const tri = (key: 'podmiotDziala' | 'profilPasuje' | 'telefonOk' | 'emailOk' | 'wwwOk', label: string) => (
    <Field label={label} key={key}>
      <select value={triValue(c[key])} onChange={(e) => setC({ ...c, [key]: fromTri(e.target.value) })}>
        <option value="">nie sprawdzono</option><option value="tak">tak</option><option value="nie">nie</option>
      </select>
    </Field>
  );

  function save() {
    patch.mutate({ patch: { checklist: c, validation: status, validationNote: note.trim() || null }, okText: 'Zapisano walidację' }, { onSuccess: onClose });
  }

  return (
    <Modal title="Lista kontrolna walidacji" onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Anuluj</button>
        <button type="button" className="btn btn-primary" disabled={patch.isPending} onClick={save}>Zapisz</button>
      </>
    }>
      <p className="hint">Wypełnij po rozmowie. Ustalasz tu, czy ten wpis to prawdziwy, działający podmiot, który nas interesuje.</p>
      {tri('podmiotDziala', 'Podmiot istnieje i działa pod tym adresem')}
      {tri('profilPasuje', 'Profil pasuje do naszej oferty')}
      {tri('telefonOk', 'Telefon działa i należy do tego podmiotu')}
      {tri('emailOk', 'E-mail potwierdzony')}
      {tri('wwwOk', 'Strona www się zgadza')}
      <Field label="Osoba decyzyjna (imię, stanowisko)"><input value={c.decydent ?? ''} onChange={(e) => setC({ ...c, decydent: e.target.value || null })} maxLength={200} /></Field>
      <Field label="Należy do sieci / grupy">
        <select value={c.siec ?? ''} onChange={(e) => setC({ ...c, siec: (e.target.value || null) as ValidationChecklist['siec'] })}>
          <option value="">nie sprawdzono</option><option value="tak">tak</option><option value="nie">nie</option><option value="nie_wiem">nie wiem</option>
        </select>
      </Field>
      <Field label="Uwagi"><textarea rows={3} value={c.uwagi ?? ''} onChange={(e) => setC({ ...c, uwagi: e.target.value || null })} maxLength={2000} /></Field>
      <Field label="Wynik: status walidacji">
        <select value={status} onChange={(e) => setStatus(Number(e.target.value) as ValidationStatus)}>
          {Object.entries(VALIDATION_PL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      <Field label="Notatka do statusu"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
    </Modal>
  );
}
