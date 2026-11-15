import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../lib/api';
import { fmtDate, fmtNum } from '../../lib/format';
import { Empty, ErrorBox, PageHeader, Spinner } from '../../components/common';
import { TaskList } from '../tasks/TaskList';
import { useMe } from '../auth/AuthProvider';

const CHANGE_PL = { changed: 'zmiana w rejestrze', gone: 'zniknął z rejestru', returned: 'wrócił do rejestru' } as const;

export default function TodayScreen() {
  const me = useMe();
  const q = useQuery({ queryKey: ['today'], queryFn: () => rpc('today', {}), staleTime: 30_000 });
  const d = q.data;
  const nothing = d && d.counts.tasksOverdue + d.counts.tasksToday + d.counts.nextSteps + d.counts.registerChanges + d.counts.openProposals === 0;
  return (
    <div>
      <PageHeader title={`Dziś — ${me.displayName}`} help="Twoje zaległe i dzisiejsze zadania oraz leady, przy których czeka następny krok." />
      {q.isPending ? <Spinner /> : null}
      {q.isError ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : null}
      {nothing ? <Empty title="Na dziś nic nie czeka.">Otwórz „Leady”, wybierz widok (np. POZ) i zacznij od telefonu. Zadania i następne kroki pojawią się tu same.</Empty> : null}
      {d && d.tasksOverdue.length > 0 ? <section className="panel"><h2 className="overdue">Zaległe zadania ({fmtNum(d.counts.tasksOverdue)})</h2><TaskList tasks={d.tasksOverdue} empty="" /></section> : null}
      {d && d.tasksToday.length > 0 ? <section className="panel"><h2>Zadania na dziś ({fmtNum(d.counts.tasksToday)})</h2><TaskList tasks={d.tasksToday} empty="" /></section> : null}
      {d && d.nextSteps.length > 0 ? (
        <section className="panel"><h2>Następne kroki na dziś ({fmtNum(d.counts.nextSteps)})</h2>
          <ul className="plain">{d.nextSteps.map((r) => (
            <li key={r.id}><Link to={`/lead/${r.id}`}>{r.name ?? '(bez nazwy)'}</Link> <span className="muted">· {fmtDate(r.nextStepAt)}{r.nextStepNote ? ` · ${r.nextStepNote}` : ''}</span></li>
          ))}</ul>
        </section>
      ) : null}
      {d && d.registerChanges.length > 0 ? (
        <section className="panel"><h2>Zmiany w rejestrze u Twoich leadów ({fmtNum(d.counts.registerChanges)})</h2>
          <ul className="plain">{d.registerChanges.map((c) => (
            <li key={c.row.id}><Link to={`/lead/${c.row.id}`}>{c.row.name ?? '(bez nazwy)'}</Link> <span className="muted">· {CHANGE_PL[c.change]}{c.fields.length ? `: ${c.fields.join(', ')}` : ''}</span></li>
          ))}</ul>
        </section>
      ) : null}
      {d && d.counts.openProposals > 0 ? <section className="panel"><h2>Walidacja</h2><p>Propozycje do przejrzenia: <strong>{fmtNum(d.counts.openProposals)}</strong>. <Link to="/walidacja">Otwórz Walidację</Link></p></section> : null}
    </div>
  );
}
