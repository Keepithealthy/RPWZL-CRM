import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PROPOSAL_STATUS, type LeadFilter, type ProposalStatus } from '../../lib/contract';
import { errorText } from '../../lib/api';
import { fmtNum } from '../../lib/format';
import { Empty, ErrorBox, PageHeader, Spinner } from '../../components/common';
import { useUi } from '../../components/ui';
import { NetworkDialog, type NetworkChoice } from './NetworkDialog';
import { ProposalCard } from './ProposalCard';
import { RecordsQueue } from './RecordsQueue';
import { groupProposals, type ProposalGroup } from './grouping';
import {
  QUEUE_PAGE, proposalDetailQuery, useDecideGroup, useSegments, useValQueue, useValSummary, type QueueName,
} from './hooks';
import './validation.css';

type Tab = 'accounts' | 'networks' | 'records';
const TAB_LABEL: Record<Tab, string> = { accounts: 'Konta', networks: 'Sieci i duplikaty', records: 'Rekordy do sprawdzenia' };
const STATUS_OPTIONS: Array<[ProposalStatus, string]> = [
  [PROPOSAL_STATUS.OPEN, 'Otwarte'], [PROPOSAL_STATUS.ACCEPTED, 'Potwierdzone'], [PROPOSAL_STATUS.REJECTED, 'Odrzucone'], [PROPOSAL_STATUS.STALE, 'Nieaktualne'],
];

function typingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export default function ValidationScreen() {
  const ui = useUi();
  const qc = useQueryClient();
  const segments = useSegments();
  const [tab, setTab] = useState<Tab>('accounts');
  const [segmentId, setSegmentId] = useState<number | ''>('');
  const [status, setStatus] = useState<ProposalStatus>(PROPOSAL_STATUS.OPEN);
  const [page, setPage] = useState(0);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [networkFor, setNetworkFor] = useState<ProposalGroup | null>(null);
  const decide = useDecideGroup();
  const refs = useRef(new Map<string, HTMLElement>());

  const segment: LeadFilter | null = useMemo(() => segments.find((s) => s.id === segmentId)?.filter ?? null, [segments, segmentId]);
  const summary = useValSummary(segment);
  const queue: QueueName = tab === 'networks' ? 'networks' : 'accounts';
  const q = useValQueue(queue, status, segment, page);
  const groups = useMemo(() => {
    const g = groupProposals(q.data ?? [], queue === 'networks');
    // postponed cards sink to the end of the open list, keeping their order
    return [...g.filter((x) => !skipped.has(x.key)), ...g.filter((x) => skipped.has(x.key))];
  }, [q.data, queue, skipped]);

  const resetView = useCallback(() => { setPage(0); setActiveKey(null); }, []);
  const active = groups.find((g) => g.key === activeKey) ?? groups[0] ?? null;
  const open = status === PROPOSAL_STATUS.OPEN;

  const apply = useCallback(async (group: ProposalGroup, action: Parameters<typeof decide.mutateAsync>[0]['action'], okText: string) => {
    try {
      await decide.mutateAsync({ group, action });
      ui.toast(okText);
      setNetworkFor(null);
    } catch (e) {
      ui.toast(errorText(e), 'error');
    }
  }, [decide, ui]);

  const onAccept = useCallback(async (group: ProposalGroup) => {
    if (queue === 'networks') {
      // the dialog needs the entries (names, accounts) of the card
      try {
        await qc.fetchQuery({ ...proposalDetailQuery(group.proposals[0]!.id), staleTime: 30_000 });
        setNetworkFor(group);
      } catch (e) {
        ui.toast(errorText(e), 'error');
      }
      return;
    }
    await apply(group, { type: 'accept' }, 'Zapisano: to ten sam podmiot');
  }, [apply, qc, queue, ui]);
  const onReject = useCallback((group: ProposalGroup) => apply(group, { type: 'reject' }, queue === 'networks' ? 'Zapisano: to nie jest sieć' : 'Zapisano: to różne podmioty'), [apply, queue]);
  const onLater = useCallback((group: ProposalGroup) => {
    setSkipped((s) => new Set(s).add(group.key));
    const i = groups.findIndex((g) => g.key === group.key);
    const next = groups.slice(i + 1).find((g) => !skipped.has(g.key)) ?? null;
    setActiveKey(next?.key ?? null);
  }, [groups, skipped]);

  // keyboard review: J/K or arrows move, T accept, N reject, L later, O open the first entry
  useEffect(() => {
    if (tab === 'records') return;
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typingTarget(e.target) || networkFor || decide.isPending) return;
      if ((e.target as HTMLElement | null)?.closest?.('dialog')) return;
      const key = e.key.toLowerCase();
      const idx = active ? groups.findIndex((g) => g.key === active.key) : -1;
      const move = (to: number) => {
        const g = groups[Math.max(0, Math.min(groups.length - 1, to))];
        if (g) { setActiveKey(g.key); refs.current.get(g.key)?.scrollIntoView?.({ block: 'nearest' }); }
      };
      if (key === 'j' || key === 'arrowdown') { e.preventDefault(); move(idx + 1); }
      else if (key === 'k' || key === 'arrowup') { e.preventDefault(); move(idx - 1); }
      else if (open && active && key === 't') { e.preventDefault(); void onAccept(active); }
      else if (open && active && key === 'n') { e.preventDefault(); void onReject(active); }
      else if (open && active && key === 'l') { e.preventDefault(); onLater(active); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tab, active, groups, open, networkFor, decide.isPending, onAccept, onReject, onLater]);

  const counts = summary.data;
  const tabCount = (t: Tab): number | null => {
    if (!counts) return null;
    return t === 'records' ? counts.records.doSprawdzenia : counts.queues[t].open;
  };

  return (
    <div>
      <PageHeader
        title="Walidacja"
        help="Tu potwierdzasz, kto jest kim: które wpisy to ten sam podmiot, które należą do jednej sieci i które dane są błędne."
      />
      <div className="val-toolbar">
        <label className="field">
          <span className="field-label">Pokaż tylko propozycje dla widoku</span>
          <select value={segmentId} onChange={(e) => { setSegmentId(e.target.value === '' ? '' : Number(e.target.value)); resetView(); }}>
            <option value="">Wszystkie</option>
            {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {tab !== 'records' ? (
          <label className="field">
            <span className="field-label">Pokaż</span>
            <select value={status} onChange={(e) => { setStatus(Number(e.target.value) as ProposalStatus); resetView(); }}>
              {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        ) : null}
      </div>

      <div role="tablist" className="tabs" aria-label="Kolejki walidacji">
        {(['accounts', 'networks', 'records'] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" id={`val-tab-${t}`} aria-selected={tab === t} aria-controls="val-panel" className={tab === t ? 'on' : undefined}
            onClick={() => { setTab(t); resetView(); }}>
            {TAB_LABEL[t]}{tabCount(t) !== null ? ` (${fmtNum(tabCount(t))})` : ''}
          </button>
        ))}
      </div>

      <div id="val-panel" role="tabpanel" aria-labelledby={`val-tab-${tab}`}>
        {tab === 'records' ? <RecordsQueue segment={segment} /> : (
          <>
            <p className="hint val-help">Pewność to szacunek maszyny (0–100). Powyżej 80 zwykle wystarczy szybki rzut oka.</p>
            {open ? (
              <p className="val-keys" aria-label="Skróty klawiszowe">
                Szybki przegląd: <kbd>J</kbd>/<kbd>K</kbd> następna / poprzednia · <kbd>T</kbd> {queue === 'networks' ? 'potwierdź sieć' : 'to ten sam podmiot'} · <kbd>N</kbd> {queue === 'networks' ? 'to nie jest sieć' : 'to różne podmioty'} · <kbd>L</kbd> później
              </p>
            ) : null}
            {q.isLoading ? <Spinner /> : q.isError ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : groups.length === 0 ? (
              <Empty title={open ? 'Nic do przejrzenia.' : 'Brak propozycji w tej kategorii.'}>
                {open ? 'Wszystkie propozycje w tym widoku mają już decyzję. Nowe pojawią się po kolejnym imporcie rejestru.' : undefined}
              </Empty>
            ) : (
              <div aria-busy={q.isFetching}>
                {groups.map((g) => (
                  <ProposalCard
                    key={g.key}
                    ref={(el) => { if (el) refs.current.set(g.key, el); else refs.current.delete(g.key); }}
                    group={g}
                    queue={queue}
                    active={active?.key === g.key}
                    skipped={skipped.has(g.key)}
                    busy={decide.isPending}
                    onActivate={() => setActiveKey(g.key)}
                    onAccept={() => void onAccept(g)}
                    onReject={() => void onReject(g)}
                    onLater={() => onLater(g)}
                    onReopen={() => void apply(g, { type: 'reopen' }, 'Decyzja cofnięta — propozycja wróciła do otwartych')}
                  />
                ))}
                <nav className="pager" aria-label="Strony propozycji">
                  <button type="button" className="btn btn-sm" disabled={page <= 0} onClick={() => { setPage(page - 1); setActiveKey(null); }}>‹ Poprzednia</button>
                  <span>Strona {page + 1}</span>
                  <button type="button" className="btn btn-sm" disabled={(q.data?.length ?? 0) < QUEUE_PAGE} onClick={() => { setPage(page + 1); setActiveKey(null); }}>Następna ›</button>
                </nav>
              </div>
            )}
          </>
        )}
      </div>

      {networkFor ? <NetworkFromCache group={networkFor} busy={decide.isPending} onClose={() => setNetworkFor(null)} onConfirm={(c) => void apply(networkFor, { type: 'accept-network', ...c }, 'Zapisano sieć')} /> : null}
    </div>
  );
}

/** Reads the already fetched proposal detail (entries of all member accounts) for the network dialog. */
function NetworkFromCache({ group, busy, onClose, onConfirm }: { group: ProposalGroup; busy: boolean; onClose: () => void; onConfirm: (c: NetworkChoice) => void }) {
  const detail = useQuery({ ...proposalDetailQuery(group.proposals[0]!.id), staleTime: 30_000 });
  if (!detail.data) return null;
  return <NetworkDialog entries={detail.data.entries} memberKeys={group.members} busy={busy} onClose={onClose} onConfirm={onConfirm} />;
}
