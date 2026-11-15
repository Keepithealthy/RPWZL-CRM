import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { LeadList } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { encodeFilter } from '../../lib/filterCodec';
import { fmtDate, fmtNum } from '../../lib/format';
import { memberName, useRefData } from '../../lib/queries';
import { useMe } from '../auth/AuthProvider';
import { Empty, Field, PageHeader } from '../../components/common';
import { Modal } from '../../components/Modal';
import { useUi } from '../../components/ui';

export default function ListsScreen() {
  const ref = useRefData().data ?? null;
  const me = useMe();
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [edit, setEdit] = useState<Partial<LeadList> | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['ref'] });
  const del = useMutation({
    mutationFn: (id: number) => rpc('list_delete', { p_id: id }),
    onSuccess: () => { toast('Usunięto listę'); void refresh(); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const lists = ref?.lists ?? [];
  return (
    <div>
      <PageHeader title="Listy" help="Statyczne listy leadów, np. „Kampania styczeń”. Leady dodajesz na ekranie Leady: zaznacz wiersze → Akcje zbiorcze → Dodaj do listy.">
        <button type="button" className="btn btn-primary" onClick={() => setEdit({})}>Nowa lista</button>
      </PageHeader>
      {lists.length === 0 ? <Empty title="Nie ma jeszcze list.">Utwórz listę przyciskiem „Nowa lista” albo od razu podczas dodawania leadów (Leady → zaznacz → Dodaj do listy).</Empty> : (
        <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Nazwa</th><th>Leadów</th><th>Utworzył(a)</th><th>Zmieniono</th><th /></tr></thead>
          <tbody>
            {lists.map((l) => (
              <tr key={l.id}>
                <td><Link to={`/leady?f=${encodeFilter({ listId: l.id })}`}><strong>{l.name}</strong></Link>{l.note ? <div className="muted">{l.note}</div> : null}</td>
                <td>{fmtNum(l.members)}</td><td>{memberName(ref, l.createdBy)}</td><td>{fmtDate(l.updatedAt)}</td>
                <td className="actions">
                  <Link to={`/leady?f=${encodeFilter({ listId: l.id })}`}>Otwórz</Link>
                  {l.createdBy === me.memberId || me.role === 'owner' ? (
                    <>
                      <button type="button" className="link" onClick={() => setEdit(l)}>Zmień nazwę</button>
                      <button type="button" className="link" onClick={async () => { if (await confirm(`Usunąć listę „${l.name}”? Leady zostaną, znika tylko lista. Tej operacji nie można cofnąć.`, { danger: true, confirmLabel: 'Usuń' })) del.mutate(l.id); }}>Usuń</button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {edit ? <ListDialog list={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void refresh(); }} /> : null}
    </div>
  );
}

function ListDialog({ list, onClose, onSaved }: { list: Partial<LeadList>; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const [name, setName] = useState(list.name ?? '');
  const [note, setNote] = useState(list.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => rpc('list_upsert', { p_list: { id: list.id, name: name.trim(), note: note.trim() || null } }),
    onSuccess: () => { toast('Zapisano listę'); onSaved(); },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal title={list.id ? 'Zmień listę' : 'Nowa lista'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Anuluj</button><button type="button" className="btn btn-primary" disabled={!name.trim() || m.isPending} onClick={() => m.mutate()}>Zapisz</button></>}>
      <Field label="Nazwa listy"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus /></Field>
      <Field label="Opis (opcjonalnie)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
    </Modal>
  );
}
