import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LeadCard } from '../../lib/contract';
import { rpc } from '../../lib/api';
import { TaskList } from '../tasks/TaskList';
import { TaskDialog } from '../tasks/TaskDialog';
import { ErrorBox } from '../../components/common';

export function CardTasks({ card }: { card: LeadCard }) {
  const [adding, setAdding] = useState(false);
  const id = card.row.id;
  const open = useQuery({ queryKey: ['tasks', 'entry', id, true], queryFn: () => rpc('tasks_list', { p_scope: 'all', p_open: true, p_due_to: null, p_entry_id: id, p_offset: 0, p_limit: 100 }) });
  const done = useQuery({ queryKey: ['tasks', 'entry', id, false], queryFn: () => rpc('tasks_list', { p_scope: 'all', p_open: false, p_due_to: null, p_entry_id: id, p_offset: 0, p_limit: 100 }) });
  return (
    <div>
      <button type="button" className="btn" onClick={() => setAdding(true)}>Nowe zadanie</button>
      <h3>Otwarte</h3>
      {open.isError ? <ErrorBox error={open.error} /> : <TaskList tasks={open.data ?? []} showLead={false} empty="Brak otwartych zadań dla tego leada." />}
      <h3>Zrobione</h3>
      {done.isError ? <ErrorBox error={done.error} /> : <TaskList tasks={done.data ?? []} showLead={false} empty="Nic jeszcze nie zrobiono." />}
      {adding ? <TaskDialog entryId={id} entryName={card.row.name} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
