import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TEMPLATE_VARIABLES, type Template, type TemplateKind } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { smsCount, smsCounterText, stripPolish } from '../../lib/links';
import { SAMPLE_VARS, VARIABLE_HELP, buildVars, renderTemplate } from '../../lib/template';
import { useRefData } from '../../lib/queries';
import { useMe } from '../auth/AuthProvider';
import { Empty, ErrorBox, Field, PageHeader, Spinner } from '../../components/common';
import { useUi } from '../../components/ui';

const KINDS: Array<[TemplateKind, string]> = [['email', 'E-mail'], ['sms', 'SMS'], ['call', 'Skrypt rozmowy']];

export default function TemplatesScreen() {
  const [kind, setKind] = useState<TemplateKind>('email');
  const [editing, setEditing] = useState<Partial<Template> | null>(null);
  const q = useQuery({ queryKey: ['templates'], queryFn: () => rpc('templates_list', {}), staleTime: 30_000 });
  const list = (q.data ?? []).filter((t) => t.kind === kind).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  return (
    <div>
      <PageHeader title="Szablony" help="Gotowe teksty e-maili, SMS-ów i skrypty rozmów. Zmienne w nawiasach {{…}} są podmieniane danymi leada.">
        <button type="button" className="btn btn-primary" onClick={() => setEditing({ kind, active: true, subject: '', body: '', name: '' })}>Nowy szablon</button>
      </PageHeader>
      <div role="tablist" className="tabs" aria-label="Rodzaj szablonu">
        {KINDS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'on' : undefined} onClick={() => { setKind(k); setEditing(null); }}>{l}</button>)}
      </div>
      {q.isPending ? <Spinner /> : null}
      {q.isError ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : null}
      <div className="split">
        <div>
          {q.isSuccess && list.length === 0 ? <Empty title="Brak szablonów tego rodzaju.">Kliknij „Nowy szablon”. Zacznij od krótkiego „Dzień dobry, …” z nazwą w mianowniku.</Empty> : null}
          <ul className="tlist">
            {list.map((t) => (
              <li key={t.id}><button type="button" className={editing?.id === t.id ? 'on' : undefined} onClick={() => setEditing(t)}>{t.name}{t.active ? '' : ' (nieaktywny)'}</button></li>
            ))}
          </ul>
        </div>
        {editing ? <Editor key={editing.id ?? 'new'} initial={editing} onDone={() => setEditing(null)} /> : <p className="muted">Wybierz szablon z listy albo utwórz nowy.</p>}
      </div>
    </div>
  );
}

function Editor({ initial, onDone }: { initial: Partial<Template>; onDone: () => void }) {
  const me = useMe();
  const ref = useRefData().data ?? null;
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const kind = initial.kind ?? 'email';
  const [name, setName] = useState(initial.name ?? '');
  const [subject, setSubject] = useState(initial.subject ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  const [active, setActive] = useState(initial.active ?? true);
  const [leadQ, setLeadQ] = useState('');
  const [sample, setSample] = useState<Parameters<typeof buildVars>[0]>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const search = useQuery({
    queryKey: ['leads', 'tplsearch', leadQ],
    enabled: leadQ.trim().length >= 3,
    queryFn: () => rpc('leads_search', { p_filter: { q: leadQ.trim() }, p_sort: null, p_offset: 0, p_limit: 5 }),
  });

  const vars = sample ? buildVars(sample, me, ref) : SAMPLE_VARS;
  const rb = renderTemplate(body, vars);
  const rs = renderTemplate(subject, vars);
  const unknown = [...new Set([...rb.unknown, ...rs.unknown])];

  const save = useMutation({
    mutationFn: () => rpc('template_upsert', { p_template: { id: initial.id, kind, name: name.trim(), subject: kind === 'email' ? subject : null, body, active, sort: initial.sort ?? 0 } }),
    onSuccess: () => { toast('Zapisano szablon'); void qc.invalidateQueries({ queryKey: ['templates'] }); onDone(); },
    onError: (e) => setError(errorText(e)),
  });
  const del = useMutation({
    mutationFn: () => rpc('template_delete', { p_id: initial.id! }),
    onSuccess: () => { toast('Usunięto szablon'); void qc.invalidateQueries({ queryKey: ['templates'] }); onDone(); },
    onError: (e) => toast(errorText(e), 'error'),
  });

  function insert(v: string) {
    const el = bodyRef.current;
    const tag = `{{${v}}}`;
    if (!el) return setBody(body + tag);
    const s = el.selectionStart ?? body.length;
    const e = el.selectionEnd ?? body.length;
    setBody(body.slice(0, s) + tag + body.slice(e));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + tag.length, s + tag.length); });
  }

  const smsText = ref?.settings.smsDiacritics === 'strip' ? stripPolish(rb.text) : rb.text;
  return (
    <section className="editor panel" aria-label="Edycja szablonu">
      <Field label="Nazwa szablonu"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
      {kind === 'email' ? <Field label="Temat"><input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></Field> : null}
      <Field label="Treść"><textarea ref={bodyRef} rows={10} value={body} maxLength={10000} onChange={(e) => setBody(e.target.value)} /></Field>
      <div className="chips" aria-label="Wstaw zmienną">
        {TEMPLATE_VARIABLES.map((v) => <button key={v} type="button" className="chip" title={VARIABLE_HELP[v]} onClick={() => insert(v)}>{`{{${v}}}`}</button>)}
      </div>
      <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Aktywny (widoczny przy wysyłaniu)</label>

      <h3>Podgląd</h3>
      <label className="field"><span className="field-label">Dla leada (wpisz min. 3 znaki nazwy; bez wyboru: dane przykładowe)</span>
        <input type="search" value={leadQ} onChange={(e) => setLeadQ(e.target.value)} /></label>
      {search.data?.rows.length ? (
        <ul className="plain">{search.data.rows.map((r) => <li key={r.id}><button type="button" className="link" onClick={() => { setSample({ row: r, kod: null, lead: null, contacts: [] }); setLeadQ(''); }}>{r.name} — {r.miasto}</button></li>)}</ul>
      ) : null}
      {sample ? <p className="hint">Podgląd dla: {sample.row.name} <button type="button" className="link" onClick={() => setSample(null)}>wróć do danych przykładowych</button></p> : null}
      <div className="preview" aria-live="polite">
        {kind === 'email' && rs.text ? <p><strong>Temat:</strong> {rs.text}</p> : null}
        <pre className="preview-text">{kind === 'sms' ? smsText : rb.text || '(pusto)'}</pre>
      </div>
      {kind === 'sms' ? <p className="counter">{smsCounterText(smsCount(smsText))}</p> : null}
      {unknown.length ? <div className="alert alert-warn">Nieznane zmienne: {unknown.map((v) => `{{${v}}}`).join(', ')}. Zostaną w tekście bez zmian.</div> : null}
      {rb.empty.length ? <p className="hint">W tym podglądzie puste: {rb.empty.join(', ')}.</p> : null}
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
      <div className="btnrow">
        <button type="button" className="btn btn-primary" disabled={!name.trim() || !body.trim() || save.isPending} onClick={() => save.mutate()}>Zapisz</button>
        <button type="button" className="btn" onClick={onDone}>Anuluj</button>
        {initial.id ? <button type="button" className="btn btn-danger" onClick={async () => { if (await confirm('Usunąć szablon? Tej operacji nie można cofnąć.', { danger: true, confirmLabel: 'Usuń' })) del.mutate(); }}>Usuń</button> : null}
      </div>
    </section>
  );
}
