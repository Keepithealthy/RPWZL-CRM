import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SOURCE_LABEL_PL, ENTITY_TYPE_PL, VALIDATION_PL, type LeadCard, type ValidationStatus } from '../../lib/contract';
import { fmtDate } from '../../lib/format';
import { openExternalLink, telLink } from '../../lib/links';
import { useRefData } from '../../lib/queries';
import { useIsOwner } from '../auth/AuthProvider';
import { Badge, ErrorBox, Field, Spinner } from '../../components/common';
import { Modal } from '../../components/Modal';
import { useUi } from '../../components/ui';
import { TaskDialog } from '../tasks/TaskDialog';
import { ChecklistDialog } from './ChecklistDialog';
import { ComposerDialog } from './ComposerDialog';
import { ContactTab } from './ContactTab';
import { CardTasks } from './CardTasks';
import { OutcomeDialog, type OutcomeInitial } from './OutcomeDialog';
import { RegisterTab } from './RegisterTab';
import { RelatedTab } from './RelatedTab';
import { Timeline } from './Timeline';
import { collectPhones } from './contacts';
import { useCard, useLeadPatch } from './hooks';

type DialogState =
  | { t: 'callpick' } | { t: 'compose'; kind: 'sms' | 'email'; to?: string } | { t: 'outcome'; initial: OutcomeInitial }
  | { t: 'task' } | { t: 'checklist' } | { t: 'shortname' } | { t: 'dnc' };

const TABS = [['historia', 'Historia'], ['kontakt', 'Kontakt'], ['rejestr', 'Dane z rejestru'], ['powiazane', 'Powiązane'], ['zadania', 'Zadania']] as const;

export default function CardScreen() {
  const { id } = useParams();
  const nav = useNavigate();
  const q = useCard(Number(id));
  return (
    <div className="card-screen">
      <button type="button" className="link back" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/leady'))}>← Wróć do listy</button>
      {q.isPending ? <Spinner /> : null}
      {q.isError ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data ? <CardView card={q.data} /> : null}
    </div>
  );
}

function CardView({ card }: { card: LeadCard }) {
  const ref = useRefData().data ?? null;
  const isOwner = useIsOwner();
  const { toast } = useUi();
  const [sp, setSp] = useSearchParams();
  const tab = TABS.find(([k]) => k === sp.get('tab'))?.[0] ?? 'historia';
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const patch = useLeadPatch(card);
  const savedAt = card.row.nextStepAt?.slice(0, 10) ?? '';
  const savedNote = card.row.nextStepNote ?? '';
  const [nextAt, setNextAt] = useState(savedAt);
  const [nextNote, setNextNote] = useState(savedNote);
  // the next step can also be saved by the call/SMS log dialog: follow the saved value instead of keeping the first one
  const [seen, setSeen] = useState({ at: savedAt, note: savedNote });
  if (seen.at !== savedAt || seen.note !== savedNote) {
    setSeen({ at: savedAt, note: savedNote });
    setNextAt(savedAt);
    setNextNote(savedNote);
  }
  const r = card.row;
  const regStatus = (r.kind === 'p' ? card.facets['p.status'] : card.facets['r.status'])?.[0];
  const isNew = ref?.lastImport && card.firstRun?.id === ref.lastImport.id;
  const close = () => setDialog(null);

  const phones = collectPhones(card).filter((p) => !p.invalid);
  function startCall(raw: string) {
    const link = telLink(raw);
    if (link.href === null) return toast('Ten numer jest niepełny albo nie da się go jednoznacznie wybrać. Sprawdź go w rejestrze i popraw na zakładce „Kontakt”.', 'error');
    openExternalLink(link.href);
    setDialog({ t: 'outcome', initial: { type: 'call', contactValue: raw } });
  }
  function onCall(raw?: string) {
    if (raw) return startCall(raw);
    if (phones.length === 0) return toast('Ten lead nie ma numeru telefonu. Dodaj go na zakładce „Kontakt”.', 'error');
    const best = phones.find((p) => p.primary) ?? phones[0]!;
    if (phones.length === 1) return startCall(best.raw);
    setDialog({ t: 'callpick' });
  }

  const owners = (ref?.members ?? []).filter((m) => m.active || m.id === r.ownerId);
  // short enough for the narrowest grid cell (UX-R3-1); the full wording is in the select's title
  const derivedLabel = `Auto: ${VALIDATION_PL[r.validation]}`;

  return (
    <article>
      <header className="card-head">
        <div className="card-title">
          <h1>{r.name ?? '(bez nazwy)'}</h1>
          <button type="button" className="link" onClick={() => setDialog({ t: 'shortname' })} aria-label="Zmień nazwę krótką">✎ nazwa krótka{card.lead?.shortName ? `: ${card.lead.shortName}` : ''}</button>
        </div>
        <p className="muted">{ENTITY_TYPE_PL[r.entityType]} · {SOURCE_LABEL_PL[r.src]}{regStatus ? ` · status w rejestrze: ${regStatus}` : ''}{r.nip ? ` · NIP ${r.nip}` : ''}{r.miasto ? ` · ${r.miasto}` : ''}</p>
        <div className="badges">
          {!r.inRegister ? <Badge tone="red">zniknął z rejestru{card.lastChange ? ` (${fmtDate(card.lastChange.reportDate)})` : ''}</Badge> : null}
          {r.dnc ? <Badge tone="red">nie kontaktować{card.lead?.dncReason ? ` — ${card.lead.dncReason}` : ''}</Badge> : null}
          {isNew ? <Badge tone="green">nowy wpis</Badge> : null}
          {r.accountSize > 1 ? <Badge tone="blue">konto: {r.accountSize} wpisy</Badge> : null}
          {card.network ? <Badge tone="blue">sieć: {card.network.name}</Badge> : null}
        </div>
        {r.dnc ? <div className="alert alert-warn">Lead oznaczony: nie kontaktować{card.lead?.dncReason ? ` (${card.lead.dncReason})` : ''}. Szybkie akcje nadal działają — upewnij się, że kontakt jest uzasadniony.</div> : null}
        {card.lead?.regChangedAfterValidation ? <div className="alert alert-warn">Dane w rejestrze zmieniły się po walidacji tego leada. Sprawdź kontakt jeszcze raz.</div> : null}

        <div className="quick" role="group" aria-label="Szybkie akcje">
          <button type="button" className="btn btn-primary" onClick={() => onCall()}>Zadzwoń</button>
          <button type="button" className="btn" onClick={() => setDialog({ t: 'compose', kind: 'sms' })}>SMS</button>
          <button type="button" className="btn" onClick={() => setDialog({ t: 'compose', kind: 'email' })}>E-mail</button>
          <button type="button" className="btn" onClick={() => setDialog({ t: 'outcome', initial: { type: 'note' } })}>Notatka</button>
          <button type="button" className="btn" onClick={() => setDialog({ t: 'task' })}>Zadanie</button>
          <button type="button" className="btn" onClick={() => setDialog({ t: 'outcome', initial: { type: 'meeting' } })}>Spotkanie</button>
        </div>

        <div className="controls">
          <Field label="Status">
            <select value={r.statusId} disabled={patch.isPending} onChange={(e) => patch.mutate({ patch: { statusId: Number(e.target.value) }, okText: 'Zmieniono status' })}>
              {(ref?.statuses ?? []).filter((s) => s.active || s.id === r.statusId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Opiekun">
            <select value={r.ownerId ?? ''} disabled={patch.isPending} onChange={(e) => patch.mutate({ patch: { ownerId: e.target.value ? Number(e.target.value) : null }, okText: 'Zmieniono opiekuna' })}>
              <option value="">(bez opiekuna)</option>
              {owners.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
          </Field>
          <Field label="Walidacja">
            <select className="select-wide" value={r.validationIsDerived ? 'derived' : r.validation} disabled={patch.isPending}
              title={r.validationIsDerived ? `Ustawione automatycznie na podstawie reguł walidacji: ${VALIDATION_PL[r.validation]}` : undefined}
              onChange={(e) => patch.mutate({ patch: { validation: e.target.value === 'derived' ? null : (Number(e.target.value) as ValidationStatus) }, okText: 'Zmieniono walidację' })}>
              <option value="derived">{derivedLabel}</option>
              {Object.entries(VALIDATION_PL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <div className="field">
            <span className="field-label">Lista kontrolna</span>
            <button type="button" className="btn" onClick={() => setDialog({ t: 'checklist' })}>Otwórz listę kontrolną</button>
          </div>
          <div className="field wide">
            <span className="field-label">Następny krok</span>
            <div className="row2">
              <input type="date" aria-label="Data następnego kroku" value={nextAt} onChange={(e) => setNextAt(e.target.value)} />
              <input aria-label="Opis następnego kroku" placeholder="np. oddzwonić w sprawie oferty" value={nextNote} maxLength={200} onChange={(e) => setNextNote(e.target.value)} />
            </div>
            <div className="btnrow">
              <button type="button" className="btn btn-sm" disabled={patch.isPending || (nextAt === (r.nextStepAt?.slice(0, 10) ?? '') && nextNote === (r.nextStepNote ?? ''))}
                onClick={() => patch.mutate({ patch: { nextStepAt: nextAt || null, nextStepNote: nextNote.trim() || null }, okText: 'Zapisano następny krok' })}>Zapisz krok</button>
              {nextAt ? <button type="button" className="link" onClick={() => { setNextAt(''); setNextNote(''); patch.mutate({ patch: { nextStepAt: null, nextStepNote: null }, okText: 'Usunięto następny krok' }); }}>Wyczyść</button> : null}
            </div>
          </div>
          <TagsEditor card={card} />
          <div className="field">
            <span className="field-label">Nie kontaktować</span>
            {r.dnc ? (isOwner ? <button type="button" className="btn btn-sm" onClick={() => patch.mutate({ patch: { dnc: false }, okText: 'Zdjęto oznaczenie' })}>Zdejmij oznaczenie</button> : <span className="muted">Oznaczenie zdejmuje tylko właściciel.</span>)
              : <button type="button" className="btn btn-sm" onClick={() => setDialog({ t: 'dnc' })}>Oznacz: nie kontaktować</button>}
          </div>
        </div>
      </header>

      <div role="tablist" className="tabs" aria-label="Sekcje karty">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls="tabpanel" className={tab === k ? 'on' : undefined}
            onClick={() => setSp((p) => { const n = new URLSearchParams(p); n.set('tab', k); return n; }, { replace: true })}>{l}</button>
        ))}
      </div>
      <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="tabpanel">
        {tab === 'historia' ? <Timeline entryId={r.id} /> : null}
        {tab === 'kontakt' ? <ContactTab card={card} onCall={onCall} onCompose={(kind, to) => setDialog({ t: 'compose', kind, to })} /> : null}
        {tab === 'rejestr' ? <RegisterTab card={card} /> : null}
        {tab === 'powiazane' ? <RelatedTab card={card} /> : null}
        {tab === 'zadania' ? <CardTasks card={card} /> : null}
      </div>

      {dialog?.t === 'callpick' ? (
        <Modal title="Wybierz numer" onClose={close}>
          <ul className="clist">
            {phones.map((p) => (
              <li key={p.raw}><span className="val">{p.raw}</span> {p.primary ? <Badge tone="blue">główny</Badge> : null} {p.sharedWith > 1 ? <Badge tone="yellow">wspólny z {p.sharedWith} kontami</Badge> : null} {!p.nine ? <Badge tone="yellow">numer może być niepełny</Badge> : null}
                <span className="actions"><button type="button" className="btn btn-sm btn-primary" onClick={() => startCall(p.raw)}>Zadzwoń</button></span></li>
            ))}
          </ul>
        </Modal>
      ) : null}
      {dialog?.t === 'compose' ? <ComposerDialog kind={dialog.kind} initialTo={dialog.to} card={card} onClose={close} onSent={(initial) => setDialog({ t: 'outcome', initial })} /> : null}
      {dialog?.t === 'outcome' ? <OutcomeDialog card={card} initial={dialog.initial} onClose={close} /> : null}
      {dialog?.t === 'task' ? <TaskDialog entryId={r.id} entryName={r.name} onClose={close} /> : null}
      {dialog?.t === 'checklist' ? <ChecklistDialog card={card} onClose={close} /> : null}
      {dialog?.t === 'shortname' ? <ShortNameDialog card={card} onClose={close} /> : null}
      {dialog?.t === 'dnc' ? <DncDialog card={card} onClose={close} /> : null}
    </article>
  );
}

function TagsEditor({ card }: { card: LeadCard }) {
  const ref = useRefData().data;
  const patch = useLeadPatch(card);
  const tags = card.row.tags;
  const free = (ref?.tags ?? []).filter((t) => !tags.includes(t.id));
  return (
    <div className="field wide">
      <span className="field-label">Tagi</span>
      <div className="chips">
        {tags.map((id) => (
          <span key={id} className="chip on">{ref?.tags.find((t) => t.id === id)?.name ?? id}
            <button type="button" className="chip-x" aria-label="Usuń tag" onClick={() => patch.mutate({ patch: { tags: tags.filter((x) => x !== id) }, okText: 'Usunięto tag' })}>×</button></span>
        ))}
        {free.length ? (
          <select aria-label="Dodaj tag" value="" onChange={(e) => e.target.value && patch.mutate({ patch: { tags: [...tags, Number(e.target.value)] }, okText: 'Dodano tag' })}>
            <option value="">+ dodaj tag</option>{free.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        ) : tags.length === 0 ? <span className="muted">Brak tagów w systemie (dodaje je właściciel w Ustawieniach lub akcja zbiorcza na liście).</span> : null}
      </div>
    </div>
  );
}

function ShortNameDialog({ card, onClose }: { card: LeadCard; onClose: () => void }) {
  const patch = useLeadPatch(card);
  const [v, setV] = useState(card.lead?.shortName ?? '');
  return (
    <Modal title="Nazwa krótka" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Anuluj</button>
      <button type="button" className="btn btn-primary" disabled={patch.isPending} onClick={() => patch.mutate({ patch: { shortName: v.trim() || null }, okText: 'Zapisano nazwę krótką' }, { onSuccess: onClose })}>Zapisz</button></>}>
      <p className="hint">Używana w szablonach jako {'{{nazwa_krotka}}'}, np. „Przychodnia Zdrowie” zamiast pełnej nazwy spółki.</p>
      <Field label="Nazwa krótka"><input value={v} onChange={(e) => setV(e.target.value)} maxLength={100} autoFocus /></Field>
    </Modal>
  );
}

function DncDialog({ card, onClose }: { card: LeadCard; onClose: () => void }) {
  const patch = useLeadPatch(card);
  const [reason, setReason] = useState('');
  return (
    <Modal title="Oznacz: nie kontaktować" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Anuluj</button>
      <button type="button" className="btn btn-primary" disabled={patch.isPending} onClick={() => patch.mutate({ patch: { dnc: true, dncReason: reason.trim() || null }, okText: 'Oznaczono: nie kontaktować' }, { onSuccess: onClose })}>Oznacz</button></>}>
      <p className="hint">Lead zostanie pominięty w eksportach (właściciel może to zmienić). Oznaczenie zdejmuje tylko właściciel.</p>
      <Field label="Powód (opcjonalnie)"><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus /></Field>
    </Modal>
  );
}
