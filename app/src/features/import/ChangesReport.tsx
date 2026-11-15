import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ImportChangeRow } from '../../lib/contract';
import { rpc } from '../../lib/api';
import { fmtNum } from '../../lib/format';
import { Badge, Empty, ErrorBox, Spinner } from '../../components/common';

type Change = ImportChangeRow['change'];
const TABS: Array<[Change, string]> = [['new', 'Nowe'], ['changed', 'Zmienione'], ['gone', 'Zniknęły z rejestru'], ['returned', 'Wróciły do rejestru']];
const PAGE = 50;

export const FIELD_GROUP_PL: Record<string, string> = {
  contact: 'dane kontaktowe', name: 'nazwa', nip: 'NIP', address: 'adres', status: 'status w rejestrze', legal: 'forma prawna',
  structure: 'zakres działalności', dates: 'daty', detail: 'szczegóły wpisu',
};
const OLD_KEY_PL: Record<string, string> = {
  email: 'e-mail', emails: 'e-maile', tel: 'telefon', phones: 'telefony', www: 'WWW', name: 'nazwa', nip: 'NIP', miasto: 'miasto', kod: 'kod',
  ulica: 'ulica', woj: 'województwo', status: 'status',
};

function oldText(old: Record<string, unknown> | null): string | null {
  if (!old) return null;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(old)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    parts.push(`${OLD_KEY_PL[k] ?? k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** "Zobacz zmiany" after an import (`import_changes`): tabs new / changed / gone / returned. */
export function ChangesReport({ runId, onClose }: { runId: number; onClose?: () => void }) {
  const [tab, setTab] = useState<Change>('new');
  const [onlyCrm, setOnlyCrm] = useState(false);
  const [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ['import-changes', runId, tab, onlyCrm, page],
    queryFn: () => rpc('import_changes', { p_run_id: runId, p_change: tab, p_only_crm: onlyCrm, p_offset: page * PAGE, p_limit: PAGE + 1 }),
    placeholderData: keepPreviousData,
  });
  const rows = (q.data ?? []).slice(0, PAGE);
  const hasMore = (q.data?.length ?? 0) > PAGE;

  return (
    <section className="panel" aria-labelledby="imp-changes-h">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 id="imp-changes-h">Zmiany z importu</h2>
        {onClose ? <button type="button" className="btn btn-sm" onClick={onClose}>Zamknij</button> : null}
      </div>
      <div role="tablist" className="tabs" aria-label="Rodzaj zmiany">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : undefined} onClick={() => { setTab(k); setPage(0); }}>{l}</button>
        ))}
      </div>
      <label className="inline">
        <input type="checkbox" checked={onlyCrm} onChange={(e) => { setOnlyCrm(e.target.checked); setPage(0); }} />
        <span>Tylko leady, nad którymi pracujecie w CRM (status, opiekun, notatki, zadania…)</span>
      </label>
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : rows.length === 0 ? (
        <Empty title="Brak wpisów w tej kategorii." />
      ) : (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="grid small">
            <caption className="sr-only">Zmiany w rejestrze</caption>
            <thead><tr><th>Nazwa</th><th>Miasto</th><th>NIP</th><th>Co się zmieniło</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.row.id}>
                  <td><Link to={`/lead/${c.row.id}`}>{c.row.name ?? '(bez nazwy)'}</Link>{!c.row.inRegister ? <> <Badge tone="yellow">zniknął z rejestru</Badge></> : null}</td>
                  <td>{c.row.miasto ?? '–'}</td>
                  <td className="nowrap">{c.row.nip ?? '–'}</td>
                  <td>
                    {c.fields.length ? c.fields.map((f) => <Badge key={f} tone={f === 'contact' ? 'blue' : 'gray'}>{FIELD_GROUP_PL[f] ?? f}</Badge>) : <span className="muted">{c.change === 'new' ? 'nowy wpis' : '–'}</span>}
                    {oldText(c.old) ? <p className="imp-old">Poprzednio: {oldText(c.old)}</p> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav className="pager" aria-label="Strony wyników">
        <button type="button" className="btn btn-sm" disabled={page <= 0} onClick={() => setPage(page - 1)}>‹ Poprzednia</button>
        <span>Strona {page + 1} · wpisów na stronie: {fmtNum(rows.length)}</span>
        <button type="button" className="btn btn-sm" disabled={!hasMore} onClick={() => setPage(page + 1)}>Następna ›</button>
      </nav>
    </section>
  );
}
