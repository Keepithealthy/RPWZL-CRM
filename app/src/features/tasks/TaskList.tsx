import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Task } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { fmtDate, todayIso } from '../../lib/format';
import { memberName, useRefData } from '../../lib/queries';
import { Empty } from '../../components/common';
import { useUi } from '../../components/ui';
import { TaskDialog } from './TaskDialog';

/** Task table with inline "done" tick, edit and delete. Shared by Dziś, Zadania and the card. */
export function TaskList({ tasks, showLead = true, empty }: { tasks: Task[]; showLead?: boolean; empty: string }) {
  const ref = useRefData().data ?? null;
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [edit, setEdit] = useState<Task | null>(null);
  const today = todayIso();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    void qc.invalidateQueries({ queryKey: ['today'] });
    void qc.invalidateQueries({ queryKey: ['timeline'] });
  };
  const done = useMutation({
    mutationFn: (v: { id: number; done: boolean }) => rpc('task_done', { p_id: v.id, p_done: v.done }),
    onSuccess: (t) => { toast(t.doneAt ? 'Zadanie zrobione' : 'Zadanie otwarte ponownie'); refresh(); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const del = useMutation({
    mutationFn: (id: number) => rpc('task_delete', { p_id: id }),
    onSuccess: () => { toast('Usunięto zadanie'); refresh(); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  if (tasks.length === 0) return <Empty title={empty} />;
  return (
    <>
      <div className="table-wrap">
      <table className="grid small">
        <thead><tr><th><span className="sr-only">Zrobione</span></th><th>Termin</th><th>Zadanie</th>{showLead ? <th>Lead</th> : null}<th>Przypisane</th><th /></tr></thead>
        <tbody>
          {tasks.map((t) => {
            const overdue = !t.doneAt && t.dueDate.slice(0, 10) < today;
            return (
              <tr key={t.id} className={t.doneAt ? 'done' : undefined}>
                <td><input type="checkbox" checked={Boolean(t.doneAt)} aria-label={`Zrobione: ${t.title}`} onChange={(e) => done.mutate({ id: t.id, done: e.target.checked })} /></td>
                <td className={overdue ? 'overdue' : undefined}>{fmtDate(t.dueDate)}{t.dueTime ? ` ${t.dueTime.slice(0, 5)}` : ''}</td>
                <td><strong>{t.title}</strong>{t.note ? <div className="muted">{t.note}</div> : null}</td>
                {showLead ? <td>{t.entryId ? <Link to={`/lead/${t.entryId}`}>{t.entryName ?? `#${t.entryId}`}</Link> : '–'}</td> : null}
                <td>{memberName(ref, t.assigneeId)}</td>
                <td className="actions">
                  <button type="button" className="link" onClick={() => setEdit(t)}>Edytuj</button>
                  <button type="button" className="link" onClick={async () => { if (await confirm('Usunąć zadanie? Tej operacji nie można cofnąć.', { danger: true, confirmLabel: 'Usuń' })) del.mutate(t.id); }}>Usuń</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {edit ? <TaskDialog task={edit} entryName={edit.entryName} onClose={() => setEdit(null)} /> : null}
    </>
  );
}
