import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Task } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { addDaysIso } from '../../lib/format';
import { useRefData } from '../../lib/queries';
import { useMe } from '../auth/AuthProvider';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/common';
import { useUi } from '../../components/ui';

interface Props { entryId?: number | null; entryName?: string | null; task?: Task | null; onClose: () => void; onSaved?: () => void }

export function TaskDialog({ entryId, entryName, task, onClose, onSaved }: Props) {
  const me = useMe();
  const ref = useRefData().data;
  const qc = useQueryClient();
  const { toast } = useUi();
  const [title, setTitle] = useState(task?.title ?? '');
  const [due, setDue] = useState(task?.dueDate.slice(0, 10) ?? addDaysIso(1));
  const [time, setTime] = useState(task?.dueTime?.slice(0, 5) ?? '');
  const [assignee, setAssignee] = useState(task?.assigneeId ?? me.memberId);
  const [note, setNote] = useState(task?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => rpc('task_upsert', { p_task: { id: task?.id, entryId: task?.entryId ?? entryId ?? null, title: title.trim(), dueDate: due, dueTime: time || null, assigneeId: assignee, note: note.trim() || null } }),
    onSuccess: () => {
      toast('Zapisano zadanie');
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      onSaved?.();
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal title={task ? 'Edytuj zadanie' : 'Nowe zadanie'} onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Anuluj</button>
        <button type="button" className="btn btn-primary" disabled={!title.trim() || !due || m.isPending} onClick={() => m.mutate()}>Zapisz</button>
      </>
    }>
      {entryName ? <p className="muted">Lead: {entryName}</p> : null}
      <Field label="Tytuł zadania"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus placeholder="np. Zadzwonić z ofertą" /></Field>
      <div className="row2">
        <Field label="Termin"><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Godzina (opcjonalnie)"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
      </div>
      <div className="chips" aria-label="Szybki wybór terminu">
        {([['jutro', 1], ['za 3 dni', 3], ['za tydzień', 7], ['za miesiąc', 30]] as const).map(([l, d]) => <button key={l} type="button" className="chip" onClick={() => setDue(addDaysIso(d))}>{l}</button>)}
      </div>
      <Field label="Przypisane do">
        <select value={assignee} onChange={(e) => setAssignee(Number(e.target.value))}>
          {(ref?.members ?? []).filter((x) => x.active || x.id === assignee).map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}
        </select>
      </Field>
      <Field label="Notatka"><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} /></Field>
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
    </Modal>
  );
}
