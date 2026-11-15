import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BULK_MAX, PAGE_LIMIT_MAX, type BulkTarget, type LeadFilter, type LeadSort, type SortKey } from '../../lib/contract';
import { rpc } from '../../lib/api';
import { cleanFilter, decodeFilter, encodeFilter, sameFilter } from '../../lib/filterCodec';
import { describeFilter } from '../../lib/describeFilter';
import { fmtNum, leadsPl } from '../../lib/format';
import { readPref, writePref } from '../../lib/prefs';
import { useDict, useRefData } from '../../lib/queries';
import { useIsOwner } from '../auth/AuthProvider';
import { Empty, ErrorBox, PageHeader, Pager } from '../../components/common';
import { FilterPanel } from './FilterPanel';
import { LeadsTable } from './LeadsTable';
import { BulkBar } from './BulkBar';
import { ViewBar } from './ViewBar';
import { COLUMNS, DEFAULT_COLUMNS } from './columns';

const ExportDialog = lazy(() => import('../export/ExportDialog'));

const WIDE_SCREEN = 1500;
const SORT_KEYS = new Set<string>(['name', 'miasto', 'wpis', 'stan', 'status', 'owner', 'nextStep', 'lastContact', 'qEmail', 'spec1', 'nk', 'updated']);

function parseSort(s: string | null): LeadSort | null {
  if (!s) return null;
  const [key, dir] = s.split(':');
  return key && SORT_KEYS.has(key) && (dir === 'asc' || dir === 'desc') ? { key: key as SortKey, dir } : null;
}

function useOnline(): boolean {
  const [on, setOn] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return on;
}

export default function LeadsScreen() {
  const [sp, setSp] = useSearchParams();
  const ref = useRefData().data ?? null;
  const dict = useDict();
  const isOwner = useIsOwner();
  const [columns, setColumnsState] = useState<string[]>(() => readPref('leads.columns', DEFAULT_COLUMNS));
  const [pageSize, setPageSizeState] = useState<number>(() => readPref('leads.pageSize', 50));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  // on a laptop screen the filter column would push Telefon, Status and Opiekun behind a horizontal scroll
  const [showFilters, setShowFilters] = useState(() => typeof window === 'undefined' || window.innerWidth >= WIDE_SCREEN);
  const [exporting, setExporting] = useState<{ target: BulkTarget; count: number } | null>(null);
  const [qText, setQText] = useState<string | null>(null);
  const qTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const viewId = Number(sp.get('view')) || null;
  const view = ref?.views.find((v) => v.id === viewId) ?? null;
  const filter: LeadFilter = decodeFilter(sp.get('f')) ?? view?.filter ?? {};
  const sort = parseSort(sp.get('s')) ?? view?.sort ?? null;
  const page = Math.max(0, Number(sp.get('p')) || 0);
  const modified = Boolean(view) && (sp.has('f') || sp.has('s')) && (!sameFilter(filter, view!.filter) || JSON.stringify(sort) !== JSON.stringify(view!.sort));

  const update = useCallback((mut: (n: URLSearchParams) => void) => {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      mut(n);
      return n;
    }, { replace: true });
  }, [setSp]);

  const clearSelection = useCallback(() => { setSelected(new Set()); setAllMatching(false); }, []);

  const setFilter = (f: LeadFilter) => {
    const clean = cleanFilter(f);
    update((n) => {
      if (view && sameFilter(clean, view.filter)) n.delete('f');
      else n.set('f', encodeFilter(clean));
      n.delete('p');
    });
    clearSelection();
  };
  const setSort = (key: SortKey) => {
    const cur = sort ?? { key: 'name' as SortKey, dir: 'asc' as const };
    const next: LeadSort = cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    update((n) => { n.set('s', `${next.key}:${next.dir}`); n.delete('p'); });
  };
  const setPage = (p: number) => update((n) => { if (p > 0) n.set('p', String(p)); else n.delete('p'); });
  const pickView = (id: number | null) => {
    update((n) => { n.delete('f'); n.delete('s'); n.delete('p'); if (id) n.set('view', String(id)); else n.delete('view'); });
    setQText(null);
    clearSelection();
  };
  const setColumns = (c: string[]) => { setColumnsState(c); writePref('leads.columns', c); };
  const setPageSize = (n: number) => { setPageSizeState(n); writePref('leads.pageSize', n); setPage(0); };

  const count = useQuery({ queryKey: ['leads', 'count', filter], queryFn: () => rpc('leads_count', { p_filter: filter }), placeholderData: keepPreviousData });
  const rows = useQuery({
    queryKey: ['leads', 'rows', filter, sort, page, pageSize],
    queryFn: () => rpc('leads_search', { p_filter: filter, p_sort: sort, p_offset: page * pageSize, p_limit: pageSize }),
    placeholderData: keepPreviousData,
  });
  const total = count.data?.total ?? 0;
  const list = rows.data?.rows ?? [];
  const online = useOnline();
  // the rows on screen belong to an earlier query (kept while the new one loads) and the new one cannot be answered
  const stale = !online || rows.isError || (rows.isPlaceholderData && rows.isFetching && rows.fetchStatus === 'paused');

  const description = describeFilter(filter, ref, (k, v) => dict.label(k, v));

  const selectedCount = allMatching ? total : selected.size;
  const target: BulkTarget = allMatching ? { filter } : { entryIds: [...selected] };
  const toggle = (id: number) => {
    if (allMatching) return;
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const togglePage = (on: boolean) => {
    setAllMatching(false);
    setSelected((s) => { const n = new Set(s); for (const r of list) { if (on) n.add(r.id); else n.delete(r.id); } return n; });
  };

  const onQ = (v: string) => {
    setQText(v);
    clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => setFilter({ ...filter, q: v.trim() || undefined }), 450);
  };
  const qShown = qText ?? filter.q ?? '';
  const noImport = ref !== null && ref.lastImport === null;

  return (
    <div className="leads">
      <PageHeader title="Leady" help="Wpisy z rejestru RPWDL z Waszymi statusami i notatkami. Filtry otworzysz przyciskiem „Pokaż filtry” (na szerokim ekranie są widoczne po lewej). Kliknij wiersz, aby otworzyć kartę.">
        {isOwner && total > 0 ? <button type="button" className="btn btn-sm" onClick={() => setExporting({ target: { filter }, count: total })}>Eksport wyników…</button> : null}
        <button type="button" className="btn btn-sm" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>{showFilters ? 'Ukryj filtry' : 'Pokaż filtry'}</button>
      </PageHeader>
      <div className={`leads-layout${showFilters ? '' : ' no-filters'}`}>
        {showFilters ? <aside className="filter-col" aria-label="Filtry"><FilterPanel filter={filter} onChange={setFilter} /></aside> : null}
        <section className="results" aria-label="Wyniki">
          <ViewBar view={view} modified={modified} filter={filter} sort={sort} columns={columns} onPick={pickView} />
          <div className="searchrow">
            <input type="search" className="searchbox" placeholder="Szukaj: nazwa, NIP, e-mail, telefon" aria-label="Szukaj: nazwa, NIP, e-mail, telefon" value={qShown} onChange={(e) => onQ(e.target.value)} />
            <details className="colmenu">
              <summary className="btn btn-sm">Kolumny</summary>
              <div className="popover">
                {COLUMNS.map((c) => (
                  <label key={c.key}>
                    <input type="checkbox" checked={columns.includes(c.key)} disabled={c.key === 'name'} onChange={(e) => setColumns(e.target.checked ? COLUMNS.filter((x) => x.key === c.key || columns.includes(x.key)).map((x) => x.key) : columns.filter((k) => k !== c.key))} /> {c.label}
                  </label>
                ))}
                <button type="button" className="link" onClick={() => setColumns(DEFAULT_COLUMNS)}>Przywróć domyślne</button>
              </div>
            </details>
            <label className="pagesize">Na stronie
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                {[25, 50, 100, PAGE_LIMIT_MAX].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>

          <div className="summary" aria-live="polite">
            <strong>Wyniki: {fmtNum(total)}</strong>
            {count.data ? <span> · z e-mailem: {fmtNum(count.data.email)} · z telefonem: {fmtNum(count.data.tel)} · z komórką: {fmtNum(count.data.mobile)} · z www: {fmtNum(count.data.www)} · z NIP: {fmtNum(count.data.nip)}</span> : null}
            {description.length ? <p className="hint">Filtry: {description.join(' · ')}</p> : null}
          </div>

          {selectedCount > 0 ? (
            <BulkBar count={selectedCount} target={target} isOwner={isOwner} onExport={() => setExporting({ target, count: selectedCount })} onClear={clearSelection} />
          ) : null}
          {!allMatching && selected.size > 0 && list.every((r) => selected.has(r.id)) && total > list.length ? (
            <p className="selectall">
              Zaznaczono {selected.size} na tej stronie.{' '}
              {total <= BULK_MAX ? <button type="button" className="link" onClick={() => setAllMatching(true)}>Zaznacz wszystkie {fmtNum(total)} wyników</button> : <span className="muted">Wyników jest więcej niż {fmtNum(BULK_MAX)} — zawęź filtr, aby działać na wszystkich.</span>}
            </p>
          ) : null}
          {allMatching ? <p className="selectall">Zaznaczono wszystkie {leadsPl(total)} z wyników. <button type="button" className="link" onClick={clearSelection}>Odznacz</button></p> : null}

          {stale ? <div className="alert alert-warn" role="alert">Brak połączenia z bazą – wyniki poniżej mogą być nieaktualne i nie odpowiadają ostatnim filtrom ani wyszukiwaniu.</div> : null}
          {rows.isError ? <ErrorBox error={rows.error} onRetry={() => void rows.refetch()} /> : null}
          {rows.isPending ? <p className="muted" role="status">Wczytywanie…</p> : null}
          {rows.isSuccess && list.length === 0 ? (
            noImport ? <Empty title="Brak danych z rejestru.">Właściciel musi najpierw zaimportować indeks (menu Import).</Empty>
              : <Empty title="Brak wyników.">Zmień albo wyczyść filtry (przycisk „Wyczyść wszystkie filtry” po lewej).</Empty>
          ) : null}
          {list.length > 0 ? (
            <div className={stale ? 'stale-rows' : undefined} aria-busy={stale}>
            <LeadsTable rows={list} refData={ref} columns={columns} sort={sort} onSort={setSort} selected={selected} allSelected={allMatching} onToggle={toggle} onTogglePage={togglePage} />
            </div>
          ) : null}
          {total > 0 ? <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} /> : null}
        </section>
      </div>
      {exporting ? (
        <Suspense fallback={null}>
          <ExportDialog target={exporting.target} count={exporting.count} label={view?.name ?? 'leady'} onClose={() => setExporting(null)} />
        </Suspense>
      ) : null}
    </div>
  );
}
