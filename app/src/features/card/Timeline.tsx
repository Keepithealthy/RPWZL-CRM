import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { OUTCOMES, OUTCOME_PL, type TimelineItem, type RefData, type UserActivityType } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { statusName, memberName, useRefData } from '../../lib/queries';
import { Link } from 'react-router-dom';
import { Empty, ErrorBox } from '../../components/common';
import { Modal } from '../../components/Modal';
import { useUi } from '../../components/ui';
import { invalidateLead } from './hooks';

const PAGE = 30;

export const FIELD_PL: Record<string, string> = {
  email: 'e-mail', emails: 'e-maile', tel: 'telefon', phones: 'telefony', www: 'strona www', name: 'nazwa', nip: 'NIP', miasto: 'miejscowość',
  kod: 'kod pocztowy', ulica: 'ulica', woj: 'województwo', status: 'status wpisu', forma: 'forma prawna', typ: 'typ', grupaPraktyk: 'grupa praktyk',
  organ: 'organ rejestrowy', rodzaje: 'rodzaje działalności', grp: 'grupy specjalności', spec: 'specjalności', dz: 'dziedziny', fn: 'funkcje',
  nz: 'liczba zakładów', nk: 'liczba komórek', wpis: 'data wpisu', stan: 'data zmiany', gz: 'grupa zawodowa', rodzaj: 'rodzaj', rd: 'rodzaj działalności',
  zakres: 'zakres świadczeń', detail: 'szczegóły wpisu', contact: 'kontakt', address: 'adres', legal: 'dane prawne', structure: 'struktura', dates: 'daty',
};

const oldText = (o: Record<string, unknown> | null) => (o ? Object.entries(o).map(([k, v]) => `${FIELD_PL[k] ?? k}: ${Array.isArray(v) ? v.join(', ') : String(v ?? '–')}`).join('; ') : '');

export function describeItem(it: TimelineItem, ref: RefData | null): { title: string; detail: string | null } {
  const out = it.outcome ? OUTCOME_PL[it.outcome] ?? it.outcome : null;
  switch (it.type) {
    case 'call': return { title: `Telefon${out ? `: ${out}` : ''}${it.contactValue ? ` (${it.contactValue})` : ''}`, detail: it.body };
    case 'sms': return { title: `SMS${out ? `: ${out}` : ''}${it.contactValue ? ` (${it.contactValue})` : ''}`, detail: it.body };
    case 'email': return { title: `E-mail${out ? `: ${out}` : ''}${it.subject ? ` — ${it.subject}` : ''}`, detail: it.body };
    case 'meeting': return { title: `Spotkanie${out ? `: ${out}` : ''}`, detail: it.body };
    case 'note': return { title: 'Notatka', detail: it.body };
    case 'status': return { title: `Status: ${statusName(ref, it.statusFrom)} → ${statusName(ref, it.statusTo)}`, detail: it.body };
    case 'owner': return { title: 'Zmiana opiekuna', detail: it.body };
    case 'validation': return { title: 'Walidacja', detail: it.body };
    case 'dnc': return { title: 'Nie kontaktować', detail: it.body };
    case 'task': return { title: `Zadanie wykonane: ${it.subject ?? ''}`.trim(), detail: it.body };
    case 'register_new': return { title: 'Pierwszy import z rejestru', detail: null };
    case 'register_changed': return { title: `Zmiana w rejestrze: ${(it.fields ?? []).map((f) => FIELD_PL[f] ?? f).join(', ') || 'dane'}`, detail: oldText(it.old) ? `Wcześniej — ${oldText(it.old)}` : null };
    case 'register_gone': return { title: 'Zniknął z rejestru', detail: null };
    case 'register_returned': return { title: 'Wrócił do rejestru', detail: null };
  }
}

export function Timeline({ entryId }: { entryId: number }) {
  const ref = useRefData().data ?? null;
  const [scope, setScope] = useState<'entry' | 'account'>('entry');
  const [editing, setEditing] = useState<TimelineItem | null>(null);
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const q = useInfiniteQuery({
    queryKey: ['timeline', entryId, scope],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => rpc('lead_timeline', { p_entry_id: entryId, p_scope: scope, p_before: pageParam, p_limit: PAGE }),
    getNextPageParam: (last) => (last.length >= PAGE ? last[last.length - 1]?.at ?? undefined : undefined),
  });
  const del = useMutation({
    mutationFn: (id: number) => rpc('activity_delete', { p_id: id }),
    onSuccess: () => { toast('Usunięto wpis'); invalidateLead(qc, entryId); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const items = q.data?.pages.flat() ?? [];

  return (
    <div>
      <div className="seg" role="group" aria-label="Zakres historii">
        <button type="button" className={`chip${scope === 'entry' ? ' on' : ''}`} aria-pressed={scope === 'entry'} onClick={() => setScope('entry')}>Ten wpis</button>
        <button type="button" className={`chip${scope === 'account' ? ' on' : ''}`} aria-pressed={scope === 'account'} onClick={() => setScope('account')}>Całe konto</button>
      </div>
      {q.isError ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.isPending ? <p className="muted">Wczytywanie…</p> : null}
      {q.isSuccess && items.length === 0 ? <Empty title="Brak historii.">Zadzwoń, napisz lub dodaj notatkę — każde działanie pojawi się tutaj.</Empty> : null}
      <ol className="timeline">
        {items.map((it) => {
          const d = describeItem(it, ref);
          const idNum = it.id.startsWith('a:') ? Number(it.id.slice(2)) : null;
          return (
            <li key={it.id} className={`tl tl-${it.source}`}>
              <div className="tl-head">
                <time dateTime={it.at}>{fmtDateTime(it.at)}</time>
                <strong>{d.title}</strong>
                {it.byId !== null ? <span className="muted">· {memberName(ref, it.byId)}</span> : null}
                {scope === 'account' && it.entryId !== entryId ? <Link to={`/lead/${it.entryId}`} className="muted">· inny wpis konta</Link> : null}
              </div>
              {d.detail ? <p className="tl-body">{d.detail}</p> : null}
              {it.editable && idNum !== null ? (
                <div className="tl-actions">
                  <button type="button" className="link" onClick={() => setEditing(it)}>Edytuj</button>
                  <button type="button" className="link" onClick={async () => { if (await confirm('Usunąć ten wpis z historii? Tej operacji nie można cofnąć.', { danger: true, confirmLabel: 'Usuń' })) del.mutate(idNum); }}>Usuń</button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {q.hasNextPage ? <button type="button" className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Wczytywanie…' : 'Starsze wpisy'}</button> : null}
      {editing ? <EditDialog item={editing} entryId={entryId} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function EditDialog({ item, entryId, onClose }: { item: TimelineItem; entryId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [outcome, setOutcome] = useState(item.outcome ?? '');
  const [subject, setSubject] = useState(item.subject ?? '');
  const [body, setBody] = useState(item.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const outcomes = OUTCOMES[item.type as UserActivityType] ?? [];
  const m = useMutation({
    mutationFn: () => rpc('activity_update', { p_id: Number(item.id.slice(2)), p_patch: { outcome: outcome || null, subject: subject || null, body: body || null } }),
    onSuccess: () => { toast('Zapisano'); invalidateLead(qc, entryId); onClose(); },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal title="Edytuj wpis" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Anuluj</button><button type="button" className="btn btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>Zapisz</button></>}>
      <p className="hint">Własne wpisy można zmieniać przez 24 godziny.</p>
      {outcomes.length ? (
        <label className="field"><span className="field-label">Wynik</span>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="">(brak)</option>{outcomes.map((o) => <option key={o} value={o}>{OUTCOME_PL[o] ?? o}</option>)}</select>
        </label>
      ) : null}
      {item.type === 'email' ? <label className="field"><span className="field-label">Temat</span><input value={subject} onChange={(e) => setSubject(e.target.value)} /></label> : null}
      <label className="field"><span className="field-label">Treść</span><textarea rows={5} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
    </Modal>
  );
}
