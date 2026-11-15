import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../lib/api';
import { addDaysIso, todayIso } from '../../lib/format';
import { useRefData } from '../../lib/queries';
import { Empty, ErrorBox, PageHeader, Spinner } from '../../components/common';
import { TaskDialog } from './TaskDialog';
import { TaskList } from './TaskList';

type Tab = 'mine' | 'all' | 'done';
type Due = 'all' | 'overdue' | 'today' | 'week';

export default function TasksScreen() {
  const ref = useRefData().data;
  const [tab, setTab] = useState<Tab>('mine');
  const [due, setDue] = useState<Due>('all');
  const [assignee, setAssignee] = useState('');
  const [adding, setAdding] = useState(false);
  const dueTo = due === 'overdue' ? addDaysIso(-1) : due === 'today' ? todayIso() : due === 'week' ? addDaysIso(7) : null;
  const q = useQuery({
    queryKey: ['tasks', 'list', tab, dueTo],
    queryFn: () => rpc('tasks_list', { p_scope: tab === 'mine' ? 'mine' : 'all', p_open: tab !== 'done', p_due_to: tab === 'done' ? null : dueTo, p_entry_id: null, p_offset: 0, p_limit: 200 }),
  });
  const tasks = (q.data ?? []).filter((t) => (assignee ? String(t.assigneeId) === assignee : true));
  return (
    <div>
      <PageHeader title="Zadania" help="Rzeczy do zrobienia przy leadach i poza nimi. Zaznacz pole, gdy zadanie jest wykonane.">
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>Nowe zadanie</button>
      </PageHeader>
      <div role="tablist" className="tabs" aria-label="Zadania">
        {([['mine', 'Moje otwarte'], ['all', 'Wszystkie otwarte'], ['done', 'Zrobione']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : undefined} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      <div className="filters-inline">
        {tab !== 'done' ? (
          <label className="field"><span className="field-label">Termin</span>
            <select value={due} onChange={(e) => setDue(e.target.value as Due)}><option value="all">wszystkie</option><option value="overdue">zaległe</option><option value="today">do dziś</option><option value="week">do 7 dni</option></select>
          </label>
        ) : null}
        {tab !== 'mine' ? (
          <label className="field"><span className="field-label">Przypisane do</span>
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">wszyscy</option>{(ref?.members ?? []).map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select>
          </label>
        ) : null}
      </div>
      {q.isPending ? <Spinner /> : null}
      {q.isError ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.isSuccess && tasks.length === 0 ? <Empty title="Brak zadań.">{tab === 'done' ? 'Wykonane zadania pojawią się tutaj.' : 'Dodaj zadanie przyciskiem „Nowe zadanie” albo z karty leada.'}</Empty> : null}
      {tasks.length > 0 ? <TaskList tasks={tasks} empty="" /> : null}
      {adding ? <TaskDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
