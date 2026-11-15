import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { LeadFilter, LeadSort, SavedView } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { useMe } from '../auth/AuthProvider';
import { useRefData } from '../../lib/queries';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/common';
import { useUi } from '../../components/ui';

interface Props {
  view: SavedView | null;
  modified: boolean;
  filter: LeadFilter;
  sort: LeadSort | null;
  columns: string[];
  onPick: (id: number | null) => void;
}

const SCOPE_PL = { system: 'Systemowe', shared: 'Wspólne', private: 'Prywatne' } as const;

export function ViewBar({ view, modified, filter, sort, columns, onPick }: Props) {
  const me = useMe();
  const ref = useRefData().data;
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [dialog, setDialog] = useState<'save' | 'rename' | null>(null);
  const views = ref?.views ?? [];
  const canEdit = view ? (view.scope === 'system' ? me.role === 'owner' : view.scope === 'private' ? view.ownerId === me.memberId : true) : false;

  const refresh = () => qc.invalidateQueries({ queryKey: ['ref'] });
  const overwrite = useMutation({
    mutationFn: () => rpc('view_upsert', { p_view: { id: view!.id, name: view!.name, scope: view!.scope, note: view!.note, filter, sort, columns, sortOrder: view!.sortOrder } }),
    onSuccess: () => { toast('Zapisano widok'); void refresh(); onPick(view!.id); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: () => rpc('view_delete', { p_id: view!.id }),
    onSuccess: () => { toast('Usunięto widok'); void refresh(); onPick(null); },
    onError: (e) => toast(errorText(e), 'error'),
  });

  return (
    <div className="viewbar">
      <label>
        <span className="sr-only">Widok</span>
        <select aria-label="Widok" value={view?.id ?? ''} onChange={(e) => onPick(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Widok: wszystkie leady</option>
          {(['system', 'shared', 'private'] as const).map((scope) => {
            const items = views.filter((v) => v.scope === scope);
            return items.length ? <optgroup key={scope} label={SCOPE_PL[scope]}>{items.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</optgroup> : null;
          })}
        </select>
      </label>
      {view && modified ? <span className="badge badge-yellow">zmieniono</span> : null}
      <button type="button" className="btn btn-sm" onClick={() => setDialog('save')}>Zapisz jako widok…</button>
      {view && canEdit ? (
        <>
          <button type="button" className="btn btn-sm" disabled={!modified || overwrite.isPending} onClick={() => overwrite.mutate()}>Nadpisz widok</button>
          <button type="button" className="btn btn-sm" onClick={() => setDialog('rename')}>Zmień nazwę</button>
          <button type="button" className="btn btn-sm" onClick={async () => { if (await confirm(`Usunąć widok „${view.name}”? Tej operacji nie można cofnąć.`, { danger: true, confirmLabel: 'Usuń' })) remove.mutate(); }}>Usuń</button>
        </>
      ) : null}
      {view?.note ? <p className="hint view-note">{view.note}</p> : null}
      {dialog ? <ViewDialog mode={dialog} view={view} filter={filter} sort={sort} columns={columns} isOwner={me.role === 'owner'} onClose={() => setDialog(null)} onSaved={(v) => { setDialog(null); void refresh(); onPick(v.id); }} /> : null}
    </div>
  );
}

function ViewDialog({ mode, view, filter, sort, columns, isOwner, onClose, onSaved }: {
  mode: 'save' | 'rename'; view: SavedView | null; filter: LeadFilter; sort: LeadSort | null; columns: string[]; isOwner: boolean;
  onClose: () => void; onSaved: (v: SavedView) => void;
}) {
  const { toast } = useUi();
  const [name, setName] = useState(mode === 'rename' ? view!.name : '');
  const [scope, setScope] = useState<SavedView['scope']>('shared');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => mode === 'rename'
      ? rpc('view_upsert', { p_view: { ...view!, name: name.trim() } })
      : rpc('view_upsert', { p_view: { name: name.trim(), scope, note: note.trim() || null, filter, sort, columns } }),
    onSuccess: (v) => { toast('Zapisano widok'); onSaved(v); },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal title={mode === 'rename' ? 'Zmień nazwę widoku' : 'Zapisz jako widok'} onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Anuluj</button>
        <button type="button" className="btn btn-primary" disabled={!name.trim() || m.isPending} onClick={() => m.mutate()}>Zapisz</button>
      </>
    }>
      <Field label="Nazwa widoku"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus /></Field>
      {mode === 'save' ? (
        <>
          <fieldset className="checks"><legend>Kto widzi ten widok</legend>
            <label><input type="radio" checked={scope === 'shared'} onChange={() => setScope('shared')} /> Wszyscy w zespole</label>
            <label><input type="radio" checked={scope === 'private'} onChange={() => setScope('private')} /> Tylko ja</label>
            {isOwner ? <label><input type="radio" checked={scope === 'system'} onChange={() => setScope('system')} /> Systemowy (zarządza właściciel)</label> : null}
          </fieldset>
          <Field label="Opis (opcjonalnie)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
        </>
      ) : null}
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
    </Modal>
  );
}
