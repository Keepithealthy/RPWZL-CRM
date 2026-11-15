import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PROPOSAL_KIND_PL, SOURCE_LABEL_PL, type ImportCounts, type ImportRun, type LeadRow, type ProposalKind } from '../../lib/contract';
import { rpc } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtNum } from '../../lib/format';
import { memberName, useRefOrNull } from '../../lib/queries';
import { Badge, Empty, ErrorBox, PageHeader, Spinner } from '../../components/common';
import { useUi } from '../../components/ui';
import { createBackend, type ImportBackend } from './backend';
import { ChangesReport } from './ChangesReport';
import {
  ImportCancelled, analyseFile, executeImport, recalledRun, rememberRun, type Analysis, type AnalysisProgress, type RunProgress,
} from './run';
import { ImportError, MSG_RESAVE } from './parse';
import { importFailure } from './failure';
import './import.css';

type Screen =
  | { t: 'choose'; error?: string }
  | { t: 'analysing'; fileName: string; progress: AnalysisProgress | null }
  | { t: 'preview'; analysis: Analysis; ticks: Record<string, boolean> }
  | { t: 'running'; analysis: Analysis; progress: RunProgress | null }
  | { t: 'done'; analysis: Analysis; run: ImportRun }
  | { t: 'failed'; message: string; detail: string | null; retry: boolean; analysis: Analysis };

const STEPS = ['Wybierz plik', 'Sprawdzanie zmian', 'Zatwierdź import'] as const;
const stepOf = (s: Screen) => (s.t === 'choose' ? 0 : s.t === 'analysing' ? 1 : s.t === 'preview' ? 2 : 3);

function messageOf(e: unknown): string {
  if (e instanceof ImportError) return e.messagePl;
  if (e && typeof e === 'object' && 'messagePl' in e && typeof (e as { messagePl: unknown }).messagePl === 'string') return (e as { messagePl: string }).messagePl;
  console.error('[import]', e);
  return `Nie udało się wczytać pliku. Sprawdź, czy to plik indeksu zapisany w narzędziu RPWDL. ${MSG_RESAVE}`;
}

function fmtEta(sec: number | null): string {
  if (sec === null) return 'liczenie czasu…';
  if (sec < 60) return `jeszcze ok. ${sec} s`;
  return `jeszcze ok. ${Math.ceil(sec / 60)} min`;
}

const PHASE_LABEL: Record<RunProgress['phase'], string> = {
  start: 'Rozpoczynanie…', labels: 'Wysyłanie nazw i opisów…', entries: 'Wysyłanie nowych i zmienionych wpisów…', derived: 'Aktualizacja wyników walidacji…',
  gone: 'Oznaczanie wpisów, które zniknęły z rejestru…', proposals: 'Zapisywanie propozycji do przeglądu…', finish: 'Kończenie importu…',
};

export default function ImportScreen() {
  const ui = useUi();
  const qc = useQueryClient();
  const backendRef = useRef<ImportBackend | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [screen, setScreen] = useState<Screen>({ t: 'choose' });
  const [changesRun, setChangesRun] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [stale, setStale] = useState(() => recalledRun());

  useEffect(() => () => backendRef.current?.dispose(), []);

  // leaving the page during step 3 asks for confirmation (SPEC 4.10)
  useEffect(() => {
    if (screen.t !== 'running') return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [screen.t]);

  const disposeBackend = useCallback(() => {
    backendRef.current?.dispose();
    backendRef.current = null;
  }, []);

  const start = useCallback(async (file: File) => {
    disposeBackend();
    setChangesRun(null);
    setScreen({ t: 'analysing', fileName: file.name, progress: null });
    const backend = createBackend();
    backendRef.current = backend;
    try {
      const analysis = await analyseFile(backend, rpc, file, (progress) => setScreen((s) => (s.t === 'analysing' ? { ...s, progress } : s)));
      setScreen({ t: 'preview', analysis, ticks: {} });
    } catch (e) {
      disposeBackend();
      setScreen({ t: 'choose', error: messageOf(e) });
    }
  }, [disposeBackend]);

  const onPick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) void start(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    onPick(e.dataTransfer.files);
  };

  const confirmImport = async (analysis: Analysis) => {
    const backend = backendRef.current;
    if (!backend) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setScreen({ t: 'running', analysis, progress: null });
    try {
      const run = await executeImport(backend, rpc, analysis, {
        signal: ctl.signal,
        remember: rememberRun,
        onProgress: (progress) => setScreen((s) => (s.t === 'running' ? { ...s, progress } : s)),
      });
      void qc.invalidateQueries();
      disposeBackend();
      setScreen({ t: 'done', analysis, run });
      ui.toast('Import zakończony');
    } catch (e) {
      disposeBackend();
      void qc.invalidateQueries({ queryKey: ['import-runs'] });
      setScreen(e instanceof ImportCancelled
        ? { t: 'failed', analysis, detail: null, retry: true,
          message: 'Import został przerwany. Nic się nie zepsuło — żeby go dokończyć, wybierz ten sam plik jeszcze raz (zostaną wysłane tylko brakujące wpisy).' }
        : { t: 'failed', analysis, ...importFailure(e, messageOf(e)) });
    }
  };

  const cancelRunning = async () => {
    if (await ui.confirm('Przerwać import? Wysłane już wpisy zostaną w bazie. Możesz dokończyć import później, wybierając ten sam plik.', { title: 'Przerwij import', confirmLabel: 'Przerwij', danger: true })) {
      abortRef.current?.abort();
    }
  };

  const clearStale = async () => {
    if (!stale) return;
    try {
      await rpc('import_abort', { p_run_id: stale.runId, p_reason: 'abandoned after a page reload' });
    } catch {
      /* already finished or superseded */
    }
    rememberRun(null);
    setStale(null);
    ui.toast('Przerwany import został zamknięty. Możesz zacząć od nowa.');
  };

  const step = stepOf(screen);
  return (
    <div>
      <PageHeader title="Import rejestru" help="Raz w miesiącu wczytujesz tu świeży plik z rejestru RPWDL. CRM pokaże, co się zmieniło, i dopiero po Twoim kliknięciu zapisze zmiany." />
      <ol className="imp-steps" aria-label="Kroki importu">
        {STEPS.map((l, i) => <li key={l} className={i < step ? 'done' : i === step ? 'on' : undefined} aria-current={i === step ? 'step' : undefined}>{i + 1}. {l}</li>)}
      </ol>

      {stale && screen.t !== 'running' ? (
        <div className="alert alert-warn" role="alert">
          <span>Poprzedni import pliku „{stale.fileName}” nie został dokończony (przerwane łącze lub zamknięta karta). Nic nie zostało uszkodzone.</span>
          <button type="button" className="btn btn-sm" onClick={() => void clearStale()}>Zamknij przerwany import</button>
        </div>
      ) : null}

      {screen.t === 'choose' ? (
        <section className="panel" aria-labelledby="imp-choose-h">
          <h2 id="imp-choose-h">Krok 1. Wybierz plik</h2>
          <p>Wybierz plik indeksu <code>rpwdl-index-….json.gz</code> zapisany w narzędziu RPWDL (przycisk „Zapisz indeks do pliku”). Plik zostaje na Twoim komputerze — CRM odczytuje go w przeglądarce i wysyła do bazy tylko zmiany.</p>
          {screen.error ? <div className="alert alert-error" role="alert"><span>{screen.error}</span></div> : null}
          <div
            className={`imp-drop${dragOver ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <p><strong>Przeciągnij plik tutaj</strong> albo wybierz go z dysku:</p>
            <input type="file" aria-label="Plik indeksu rejestru" accept=".gz,.json,application/gzip,application/json" onChange={(e) => { onPick(e.target.files); e.target.value = ''; }} />
          </div>
          <p className="hint">Obsługiwany jest indeks w wersji 2. Starszy plik (wersja 1) nie zawiera numeru księgi rejestrowej, więc trzeba go zapisać ponownie nowszą wersją narzędzia.</p>
        </section>
      ) : null}

      {screen.t === 'analysing' ? (
        <section className="panel" aria-live="polite">
          <h2>Krok 2. Sprawdzanie zmian</h2>
          <p>Plik: <strong>{screen.fileName}</strong>. Nic jeszcze nie zapisuję w bazie. Możesz w tym czasie przeglądać CRM w innej karcie.</p>
          <AnalysisProgressView progress={screen.progress} />
          <button type="button" className="btn" onClick={() => { disposeBackend(); setScreen({ t: 'choose' }); }}>Anuluj</button>
        </section>
      ) : null}

      {screen.t === 'preview' ? (
        <Preview
          analysis={screen.analysis}
          ticks={screen.ticks}
          onTick={(key, v) => setScreen({ ...screen, ticks: { ...screen.ticks, [key]: v } })}
          onCancel={() => { disposeBackend(); setScreen({ t: 'choose' }); }}
          onConfirm={() => void confirmImport(screen.analysis)}
        />
      ) : null}

      {screen.t === 'running' ? (
        <section className="panel" aria-live="polite">
          <h2>Krok 3. Zapisywanie w bazie</h2>
          <p><strong>Nie zamykaj tej karty</strong> do końca importu.</p>
          <RunProgressView progress={screen.progress} />
          <button type="button" className="btn" onClick={() => void cancelRunning()}>Przerwij import</button>
        </section>
      ) : null}

      {screen.t === 'failed' ? (
        <section className="panel">
          <div className="alert alert-error" role="alert"><span>{screen.message}</span></div>
          {screen.detail ? <FailureDetail detail={screen.detail} /> : null}
          {screen.retry
            ? <button type="button" className="btn btn-primary" onClick={() => setScreen({ t: 'choose' })}>Wybierz plik jeszcze raz</button>
            : <button type="button" className="btn" onClick={() => setScreen({ t: 'choose' })}>Wróć do importu</button>}
        </section>
      ) : null}

      {screen.t === 'done' ? (
        <section className="panel" aria-labelledby="imp-done-h">
          <h2 id="imp-done-h">Import zakończony</h2>
          <div className="alert alert-ok"><span>Dane z rejestru z dnia <strong>{fmtDate(screen.run.reportDate)}</strong> są w CRM. Statusy, notatki, zadania i decyzje walidacji zostały bez zmian.</span></div>
          <CountsSummary counts={screen.run.counts ?? screen.analysis.plan.total} />
          <div className="btnrow" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-primary" onClick={() => setChangesRun(screen.run.id)}>Zobacz zmiany</button>
            <Link className="btn" to="/walidacja">Przejdź do walidacji</Link>
            <button type="button" className="btn" onClick={() => setScreen({ t: 'choose' })}>Wczytaj kolejny plik</button>
          </div>
        </section>
      ) : null}

      {changesRun !== null ? <ChangesReport runId={changesRun} onClose={() => setChangesRun(null)} /> : null}

      <History onShowChanges={setChangesRun} />
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------------------------- */

function AnalysisProgressView({ progress }: { progress: AnalysisProgress | null }) {
  const phase = progress?.phase ?? 'decisions';
  const order = ['reading', 'comparing', 'validation'] as const;
  const idx = phase === 'decisions' ? -1 : phase === 'finishing-analysis' ? 3 : order.indexOf(phase as (typeof order)[number]);
  const row = (key: (typeof order)[number], label: string, i: number) => {
    const active = idx === i;
    const finished = idx > i;
    const frac = active && progress && progress.total > 0 ? Math.min(1, progress.done / progress.total) : finished ? 1 : 0;
    return (
      <li key={key}>
        <span><strong>{label}</strong> <span className="state">{finished ? 'gotowe' : active ? (progress && progress.total > 0 ? `${Math.round(frac * 100)}%` : 'w toku…') : 'czeka'}</span></span>
        {active && !(progress && progress.total > 0) ? <progress aria-label={label} /> : <progress aria-label={label} max={1} value={frac} />}
      </li>
    );
  };
  return (
    <ul className="imp-phases">
      {row('reading', 'Wczytywanie pliku', 0)}
      {row('validation', 'Walidacja („kto jest kim”)', 1)}
      {row('comparing', 'Porównywanie z bazą', 2)}
    </ul>
  );
}

function RunProgressView({ progress }: { progress: RunProgress | null }) {
  if (!progress) return <Spinner label="Rozpoczynanie…" />;
  const frac = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  return (
    <div>
      <p>{PHASE_LABEL[progress.phase]}</p>
      <progress max={1} value={frac} aria-label="Postęp importu" />
      <p className="hint">{fmtNum(progress.done)} z {fmtNum(progress.total)} · {Math.round(frac * 100)}% · {fmtEta(progress.etaSec)}</p>
    </div>
  );
}

const ROWS: Array<[keyof ImportCounts | 'otherChanges' | 'noChange', string]> = [
  ['new', 'Nowe wpisy'],
  ['changedContact', 'Zmienione dane kontaktowe'],
  ['otherChanges', 'Inne zmiany w rejestrze'],
  ['returned', 'Wróciły do rejestru'],
  ['gone', 'Zniknęły z rejestru'],
  ['noChange', 'Bez zmian'],
  ['rejected', 'Odrzucone rekordy (uszkodzone)'],
];
function cell(c: ImportCounts, key: (typeof ROWS)[number][0]): number {
  if (key === 'otherChanges') return c.changed - c.changedContact;
  if (key === 'noChange') return c.unchanged + c.derivedOnly;
  return c[key];
}

function CountsSummary({ counts }: { counts: ImportCounts }) {
  return (
    <dl className="imp-kv">
      {ROWS.map(([k, l]) => <div key={k} style={{ display: 'contents' }}><dt>{l}</dt><dd>{fmtNum(cell(counts, k))}</dd></div>)}
    </dl>
  );
}

function Preview({ analysis, ticks, onTick, onCancel, onConfirm }: {
  analysis: Analysis; ticks: Record<string, boolean>; onTick: (key: string, v: boolean) => void; onCancel: () => void; onConfirm: () => void;
}) {
  const { plan, scan, warnings, blockers, crm } = analysis;
  const allTicked = warnings.every((w) => ticks[w.key]);
  const toSend = plan.total.new + plan.total.changed + plan.total.returned;
  // measured: about 1,900 entries/s against a local database; a hosted Free database is slower, so assume 1,000/s
  const minutes = Math.max(2, Math.round(toSend / 1000 / 60));
  const proposalTotal = Object.values(scan.proposalCounts).reduce((a, b) => a + b, 0);
  const nothing = toSend === 0 && plan.total.gone === 0 && plan.total.derivedOnly === 0;
  return (
    <section className="panel" aria-labelledby="imp-prev-h">
      <h2 id="imp-prev-h">Co się zmieni</h2>
      <dl className="imp-kv">
        <dt>Plik</dt><dd>{analysis.fileName}</dd>
        <dt>Data rejestru</dt><dd>{fmtDate(scan.reportDate)}{analysis.lastRun ? <span className="muted"> (poprzedni import: {fmtDate(analysis.lastRun.reportDate)})</span> : <span className="muted"> (to będzie pierwszy import)</span>}</dd>
        <dt>Wczytane wpisy</dt><dd>{fmtNum(scan.records)}{scan.header.sources.filter((s) => s.records > 0).length ? <span className="muted"> — {scan.header.sources.filter((s) => s.records > 0).map((s) => `${SOURCE_LABEL_PL[s.id]}: ${fmtNum(s.records)}`).join(', ')}</span> : null}</dd>
      </dl>

      <div className="table-wrap">
        <table className="grid imp-counts">
          <caption className="sr-only">Podsumowanie zmian</caption>
          <thead><tr><th>Co</th><th className="num">Podmioty lecznicze</th><th className="num">Praktyki zawodowe</th><th className="num">Razem</th></tr></thead>
          <tbody>
            {ROWS.map(([k, l]) => (
              <tr key={k}>
                <td>{l}</td>
                <td className="num">{k === 'rejected' ? '' : fmtNum(cell(plan.byKind.p, k))}</td>
                <td className="num">{k === 'rejected' ? '' : fmtNum(cell(plan.byKind.r, k))}</td>
                <td className="num">{fmtNum(cell(plan.total, k))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">Import nigdy nie zmienia statusów, notatek, zadań ani decyzji walidacji.</p>
      {nothing ? <div className="alert alert-ok"><span>Baza jest już zgodna z tym plikiem — nic nie trzeba wysyłać.</span></div> : null}
      {plan.total.derivedOnly > 0 ? <p className="hint">{fmtNum(plan.total.derivedOnly)} wpisów dostanie tylko odświeżone wyniki walidacji (np. zmieniło się, ile podmiotów dzieli ten sam telefon).</p> : null}
      {scan.reducedDetail > 0 ? <p className="hint">{fmtNum(scan.reducedDetail)} wpisów ma tak obszerne szczegóły, że zostaną zapisane w skróconej postaci (podstawowe dane i kontakt są pełne).</p> : null}
      {scan.rejected > 0 ? (
        <div className="alert alert-warn" role="status"><span>Odrzucone rekordy: {fmtNum(scan.rejected)} (uszkodzone w pliku, np. bez numeru księgi). Pozostałe zostaną wczytane.</span></div>
      ) : null}

      <h3>Walidacja („kto jest kim”)</h3>
      <p>Po tym imporcie czeka {fmtNum(proposalTotal)} propozycji do przejrzenia na ekranie <Link to="/walidacja">Walidacja</Link>
        {proposalTotal > 0 ? <>: {(Object.entries(scan.proposalCounts) as Array<[ProposalKind, number]>).map(([k, n]) => `${PROPOSAL_KIND_PL[k].split(' (')[0]}: ${fmtNum(n)}`).join(' · ')}</> : null}.
        {scan.autoGenericDomains.length > 0 ? <> Uznano za zbyt popularne, by łączyć podmioty: {scan.autoGenericDomains.length} domen e-mail.</> : null}</p>

      {crm.goneTotal + crm.contactTotal > 0 ? (
        <div>
          <h3>Te zmiany dotyczą leadów, nad którymi pracujecie</h3>
          <div className="imp-lists">
            <CrmList title={`Zniknęły z rejestru: ${fmtNum(crm.goneTotal)}`} rows={crm.gone} total={crm.goneTotal} />
            <CrmList title={`Zmieniły się dane kontaktowe: ${fmtNum(crm.contactTotal)}`} rows={crm.contact} total={crm.contactTotal} />
          </div>
        </div>
      ) : null}

      {blockers.map((b) => <div key={b} className="alert alert-error" role="alert"><span>{b}</span></div>)}
      {warnings.length > 0 ? (
        <fieldset className="imp-warn">
          <legend>Uwaga — potwierdź, że chcesz kontynuować</legend>
          {warnings.map((w) => (
            <div key={w.key} className="alert alert-warn">
              <label><input type="checkbox" checked={!!ticks[w.key]} onChange={(e) => onTick(w.key, e.target.checked)} /><span>{w.text} <strong>Rozumiem i chcę kontynuować.</strong></span></label>
            </div>
          ))}
        </fieldset>
      ) : null}

      <h2 style={{ marginTop: 16 }}>Krok 3. Zatwierdź import</h2>
      {toSend > 5000 ? <p className="hint">To duży import ({fmtNum(toSend)} wpisów), potrwa kilka minut (rzędu {minutes} min). Nie zamykaj karty. Gdyby coś przerwało import, wystarczy wybrać ten sam plik jeszcze raz.</p> : null}
      <div className="btnrow">
        <button type="button" className="btn btn-primary" disabled={blockers.length > 0 || !allTicked} onClick={onConfirm}>Zatwierdź import</button>
        <button type="button" className="btn" onClick={onCancel}>Anuluj</button>
      </div>
    </section>
  );
}

function CrmList({ title, rows, total }: { title: string; rows: LeadRow[]; total: number }) {
  if (total === 0) return null;
  return (
    <div>
      <h4>{title}</h4>
      <ul>
        {rows.map((r) => <li key={r.id}><Link to={`/lead/${r.id}`} target="_blank" rel="noreferrer">{r.name ?? '(bez nazwy)'}</Link>{r.miasto ? `, ${r.miasto}` : ''}</li>)}
      </ul>
      {total > rows.length ? <p className="hint">…i {fmtNum(total - rows.length)} kolejnych (po imporcie zobaczysz pełną listę w „Zobacz zmiany”).</p> : null}
    </div>
  );
}

function History({ onShowChanges }: { onShowChanges: (runId: number) => void }) {
  const ref = useRefOrNull();
  const q = useQuery({ queryKey: ['import-runs'], queryFn: () => rpc('import_runs', {}) });
  return (
    <section className="panel" aria-labelledby="imp-hist-h" style={{ marginTop: 16 }}>
      <h2 id="imp-hist-h">Poprzednie importy</h2>
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? (
        <Empty title="Jeszcze nie było importu.">Wczytaj pierwszy plik powyżej.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="grid small">
            <caption className="sr-only">Historia importów</caption>
            <thead><tr><th>Data</th><th>Plik</th><th>Data rejestru</th><th>Wynik</th><th>Kto</th><th /></tr></thead>
            <tbody>
              {(q.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{fmtDateTime(r.finishedAt ?? r.startedAt)}</td>
                  <td>{r.fileName}</td>
                  <td className="nowrap">{fmtDate(r.reportDate)}</td>
                  <td>
                    {r.status === 'applied' ? <Badge tone="green">zakończony</Badge> : r.status === 'running' ? <Badge tone="blue">w toku</Badge> : r.status === 'aborted' ? <Badge tone="yellow">przerwany</Badge> : <Badge tone="red">nieudany</Badge>}
                    {r.counts ? <span className="muted"> nowe {fmtNum(r.counts.new)} · zmienione {fmtNum(r.counts.changed)} · zniknęły {fmtNum(r.counts.gone)}</span> : null}
                  </td>
                  <td>{memberName(ref, r.startedBy)}</td>
                  <td>{r.status === 'applied' ? <button type="button" className="btn btn-sm" onClick={() => onShowChanges(r.id)}>Zmiany</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Technical detail of a failed import on its own line, with a copy button for the message to the administrator (UX-R3-2). */
function FailureDetail({ detail }: { detail: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(detail).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <div className="imp-detail">
      <p className="hint">Szczegóły dla administratora:</p>
      <code>{detail}</code>
      {typeof navigator !== 'undefined' && navigator.clipboard ? (
        <button type="button" className="btn btn-sm" onClick={copy}>{copied ? 'Skopiowano' : 'Kopiuj szczegóły'}</button>
      ) : null}
    </div>
  );
}
