import { Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LeadFilter } from '../../lib/contract';
import { rpc } from '../../lib/api';
import { leadsPl } from '../../lib/format';
import { useRefData } from '../../lib/queries';
import { PageHeader } from '../../components/common';
import { BackupPanel } from '../backup/BackupPanel';
import ExportDialog from './ExportDialog';

/** Owner-only page: export a view / list / all leads, and the CRM backup. */
export default function ExportScreen() {
  const ref = useRefData().data;
  const [source, setSource] = useState('all');
  const [open, setOpen] = useState(false);
  const filter: LeadFilter = source === 'all' ? {} : source.startsWith('v') ? (ref?.views.find((v) => `v${v.id}` === source)?.filter ?? {}) : { listId: Number(source.slice(1)) };
  const label = source === 'all' ? 'wszystkie-leady' : source.startsWith('v') ? (ref?.views.find((v) => `v${v.id}` === source)?.name ?? 'widok') : (ref?.lists.find((l) => `l${l.id}` === source)?.name ?? 'lista');
  const count = useQuery({ queryKey: ['leads', 'count', filter], queryFn: () => rpc('leads_count', { p_filter: filter }) });
  return (
    <div>
      <PageHeader title="Eksport i kopia danych" help="Tylko dla właściciela. Eksport do Customer.io lub Excela oraz kopia zapasowa tego, co wpisał zespół." />
      <section className="panel">
        <h2>Eksport leadów</h2>
        <p>Wybierz, co wyeksportować. Dokładniejszy wybór (filtry, zaznaczone wiersze) zrobisz na ekranie Leady przyciskiem „Eksport…”.</p>
        <label className="field"><span className="field-label">Źródło</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">Wszystkie leady</option>
            <optgroup label="Widoki">{(ref?.views ?? []).map((v) => <option key={v.id} value={`v${v.id}`}>{v.name}</option>)}</optgroup>
            <optgroup label="Listy">{(ref?.lists ?? []).map((l) => <option key={l.id} value={`l${l.id}`}>{l.name}</option>)}</optgroup>
          </select>
        </label>
        <p>{count.data ? `W wybranym źródle: ${leadsPl(count.data.total)}.` : 'Liczenie…'}</p>
        <button type="button" className="btn btn-primary" disabled={!count.data?.total} onClick={() => setOpen(true)}>Eksport…</button>
      </section>
      <BackupPanel />
      {open ? <Suspense fallback={null}><ExportDialog target={{ filter }} count={count.data?.total ?? 0} label={label} onClose={() => setOpen(false)} /></Suspense> : null}
    </div>
  );
}
