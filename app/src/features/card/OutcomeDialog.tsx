import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OUTCOMES, OUTCOME_PL, type ActivityInput, type LeadCard, type UserActivityType } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { addDaysIso } from '../../lib/format';
import { renderTemplate, buildVars } from '../../lib/template';
import { useRefData } from '../../lib/queries';
import { useMe } from '../auth/AuthProvider';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/common';
import { useUi } from '../../components/ui';
import { collectPhones } from './contacts';
import { invalidateLead } from './hooks';

export interface OutcomeInitial {
  type: UserActivityType;
  contactValue?: string | null;
  subject?: string | null;
  body?: string | null;
  outcome?: string | null;
  templateId?: number | null;
}

const TYPE_PL: Record<UserActivityType, string> = { call: 'Telefon', sms: 'SMS', email: 'E-mail', meeting: 'Spotkanie', note: 'Notatka' };

/** "Zapisz wynik kontaktu" (SPEC 4.4): one RPC saves the activity and the optional status / next step / task / dnc. */
export function OutcomeDialog({ card, initial, onClose }: { card: LeadCard; initial: OutcomeInitial; onClose: () => void }) {
  const me = useMe();
  const ref = useRefData().data;
  const qc = useQueryClient();
  const { toast } = useUi();
  const [type, setType] = useState<UserActivityType>(initial.type);
  const [contact, setContact] = useState(initial.contactValue ?? '');
  const [outcome, setOutcome] = useState<string | null>(initial.outcome ?? null);
  const [body, setBody] = useState(initial.body ?? '');
  const [statusId, setStatusId] = useState<number>(card.row.statusId);
  const [nextAt, setNextAt] = useState(card.row.nextStepAt?.slice(0, 10) ?? '');
  const [nextNote, setNextNote] = useState(card.row.nextStepNote ?? '');
  const [taskOn, setTaskOn] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState(addDaysIso(1));
  const [dnc, setDnc] = useState(false);
  const [markBad, setMarkBad] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scripts = useQuery({ queryKey: ['templates'], queryFn: () => rpc('templates_list', {}), staleTime: 60_000, enabled: type === 'call' });
  const callScripts = (scripts.data ?? []).filter((t) => t.kind === 'call' && t.active);
  const [scriptId, setScriptId] = useState<number | null>(null);
  const script = callScripts.find((s) => s.id === scriptId) ?? callScripts[0];

  const outcomes = OUTCOMES[type];
  const alreadyDnc = card.row.dnc;

  const chooseOutcome = (o: string) => {
    setOutcome(o);
    if (o === 'nie_chce_kontaktu' && !alreadyDnc) setDnc(true);
    if (o !== 'zly_numer') setMarkBad(false);
  };
  const chooseStatus = (id: number) => {
    setStatusId(id);
    const st = ref?.statuses.find((s) => s.id === id);
    if (st?.stage === 'paused' && !nextAt) setNextAt(addDaysIso(30)); // "Nie teraz" suggests a date
  };

  const m = useMutation({
    mutationFn: async () => {
      const act: ActivityInput = { type, outcome, contactValue: contact.trim() || null, body: body.trim() || null, subject: initial.subject ?? null, templateId: initial.templateId ?? null };
      if (statusId !== card.row.statusId) act.statusId = statusId;
      if (nextAt !== (card.row.nextStepAt?.slice(0, 10) ?? '') || nextNote !== (card.row.nextStepNote ?? '')) {
        act.nextStepAt = nextAt || null;
        act.nextStepNote = nextNote.trim() || null;
      }
      if (dnc && !alreadyDnc) { act.dnc = true; act.dncReason = outcome ? OUTCOME_PL[outcome] ?? null : null; }
      if (taskOn && taskTitle.trim()) act.task = { title: taskTitle.trim(), dueDate: taskDue };
      const res = await rpc('activity_add', { p_entry_id: card.row.id, p_activity: act });
      if (markBad && contact.trim()) {
        const existing = collectPhones(card).find((p) => p.raw === contact.trim());
        await rpc('contact_upsert', { p_entry_id: card.row.id, p_contact: { id: existing?.contactId ?? undefined, kind: 'phone', value: contact.trim(), status: 'invalid', source: existing?.source ?? 'register', isPrimary: false } });
      }
      return res;
    },
    onSuccess: () => {
      toast('Zapisano wynik kontaktu');
      invalidateLead(qc, card.row.id);
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });

  const vars = buildVars(card, me, ref ?? null);
  const scriptText = script ? renderTemplate(script.body, vars).text : '';

  return (
    <Modal title="Zapisz wynik kontaktu" wide onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Pomiń</button>
        <button type="button" className="btn btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Zapisywanie…' : 'Zapisz'}</button>
      </>
    }>
      <div className="outcome-grid">
        <div>
          <Field label="Rodzaj kontaktu">
            <select value={type} onChange={(e) => { setType(e.target.value as UserActivityType); setOutcome(null); }}>
              {(Object.keys(TYPE_PL) as UserActivityType[]).map((t) => <option key={t} value={t}>{TYPE_PL[t]}</option>)}
            </select>
          </Field>
          {type !== 'note' && type !== 'meeting' ? <Field label={type === 'email' ? 'Adres użyty' : 'Numer użyty'}><input value={contact} onChange={(e) => setContact(e.target.value)} /></Field> : null}
          {outcomes.length ? (
            <fieldset className="outcomes"><legend>Wynik</legend>
              {outcomes.map((o) => (
                <button key={o} type="button" className={`chip${outcome === o ? ' on' : ''}`} aria-pressed={outcome === o} onClick={() => chooseOutcome(o)}>{OUTCOME_PL[o] ?? o}</button>
              ))}
            </fieldset>
          ) : null}
          {outcome === 'zly_numer' && contact ? <label className="check"><input type="checkbox" checked={markBad} onChange={(e) => setMarkBad(e.target.checked)} /> Oznacz numer jako błędny</label> : null}
          <Field label="Notatka" hint="Nie wpisuj danych o zdrowiu pacjentów.">
            <textarea rows={4} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>

          <h3>Co dalej (opcjonalnie)</h3>
          <Field label="Nowy status">
            <select value={statusId} onChange={(e) => chooseStatus(Number(e.target.value))}>
              {(ref?.statuses ?? []).filter((s) => s.active || s.id === statusId).map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === card.row.statusId ? ' (obecny)' : ''}</option>)}
            </select>
          </Field>
          <div className="row2">
            <Field label="Następny krok (data)"><input type="date" value={nextAt} onChange={(e) => setNextAt(e.target.value)} /></Field>
            <Field label="Następny krok (opis)"><input value={nextNote} onChange={(e) => setNextNote(e.target.value)} maxLength={200} /></Field>
          </div>
          <div className="chips" aria-label="Szybki wybór terminu następnego kroku">
            {([['jutro', 1], ['za 3 dni', 3], ['za tydzień', 7], ['za miesiąc', 30]] as const).map(([l, d]) => <button key={l} type="button" className="chip" onClick={() => setNextAt(addDaysIso(d))}>{l}</button>)}
            {nextAt ? <button type="button" className="chip" onClick={() => { setNextAt(''); setNextNote(''); }}>wyczyść</button> : null}
          </div>
          <label className="check"><input type="checkbox" checked={taskOn} onChange={(e) => setTaskOn(e.target.checked)} /> Dodaj zadanie</label>
          {taskOn ? (
            <div className="row2">
              <Field label="Tytuł zadania"><input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} maxLength={200} /></Field>
              <Field label="Termin"><input type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} /></Field>
            </div>
          ) : null}
          {!alreadyDnc ? <label className="check"><input type="checkbox" checked={dnc} onChange={(e) => setDnc(e.target.checked)} /> Oznacz: nie kontaktować</label> : <p className="hint">Ten lead jest już oznaczony „nie kontaktować”.</p>}
        </div>
        {type === 'call' && callScripts.length ? (
          <aside className="script" aria-label="Skrypt rozmowy">
            <h3>Skrypt rozmowy</h3>
            {callScripts.length > 1 ? (
              <select aria-label="Wybierz skrypt" value={script?.id} onChange={(e) => setScriptId(Number(e.target.value))}>{callScripts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            ) : null}
            <pre className="script-text">{scriptText}</pre>
          </aside>
        ) : null}
      </div>
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
    </Modal>
  );
}
