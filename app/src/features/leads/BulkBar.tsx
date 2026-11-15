import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { VALIDATION_PL, type BulkAction, type BulkTarget, type ValidationStatus } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { leadsPl } from '../../lib/format';
import { useRefData } from '../../lib/queries';
import { Modal } from '../../components/Modal';
import { useUi } from '../../components/ui';

export type BulkKind = 'set_status' | 'set_owner' | 'add_tag' | 'remove_tag' | 'add_to_list' | 'remove_from_list' | 'set_validation' | 'set_dnc' | 'clear_dnc';

const KIND_LABEL: Record<BulkKind, string> = {
  set_status: 'Zmień status', set_owner: 'Przypisz opiekuna', add_tag: 'Dodaj tag', remove_tag: 'Usuń tag', add_to_list: 'Dodaj do listy',
  remove_from_list: 'Usuń z listy', set_validation: 'Ustaw status walidacji', set_dnc: 'Oznacz: nie kontaktować', clear_dnc: 'Zdejmij oznaczenie „nie kontaktować”',
};

interface BarProps {
  count: number;
  target: BulkTarget;
  isOwner: boolean;
  onExport: () => void;
  onClear: () => void;
}

export function BulkBar({ count, target, isOwner, onExport, onClear }: BarProps) {
  const [kind, setKind] = useState<BulkKind | null>(null);
  const kinds = (Object.keys(KIND_LABEL) as BulkKind[]).filter((k) => k !== 'clear_dnc' || isOwner);
  return (
    <div className="bulkbar" role="region" aria-label="Akcje zbiorcze">
      <strong>Zaznaczono: {leadsPl(count)}</strong>
      <select aria-label="Akcja zbiorcza" value="" onChange={(e) => e.target.value && setKind(e.target.value as BulkKind)}>
        <option value="">Wybierz akcję…</option>
        {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </select>
      {isOwner ? <button type="button" className="btn btn-sm" onClick={onExport}>Eksport…</button> : null}
      <button type="button" className="link" onClick={onClear}>Odznacz</button>
      {kind ? <BulkDialog kind={kind} count={count} target={target} onClose={() => setKind(null)} onDone={() => { setKind(null); onClear(); }} /> : null}
    </div>
  );
}

function BulkDialog({ kind, count, target, onClose, onDone }: { kind: BulkKind; count: number; target: BulkTarget; onClose: () => void; onDone: () => void }) {
  const ref = useRefData().data;
  const qc = useQueryClient();
  const { toast } = useUi();
  const [statusId, setStatusId] = useState<number>(ref?.statuses.find((s) => !s.isDefault && s.active)?.id ?? 0);
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [tagId, setTagId] = useState<number | null>(ref?.tags[0]?.id ?? null);
  const [newName, setNewName] = useState('');
  const [listId, setListId] = useState<number | null>(ref?.lists[0]?.id ?? null);
  const [validation, setValidation] = useState<ValidationStatus | 'derived'>(1);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: async () => {
      let action: BulkAction;
      let doneText: string;
      switch (kind) {
        case 'set_status': action = { action: 'set_status', statusId }; doneText = 'Zmieniono status'; break;
        case 'set_owner': action = { action: 'set_owner', ownerId }; doneText = 'Przypisano opiekuna'; break;
        case 'add_tag': {
          let id = tagId;
          if (newName.trim()) id = (await rpc('tag_upsert', { p_tag: { name: newName.trim() } })).id;
          if (id === null) throw new Error('no tag');
          action = { action: 'add_tag', tagId: id }; doneText = 'Dodano tag'; break;
        }
        case 'remove_tag': if (tagId === null) throw new Error('no tag'); action = { action: 'remove_tag', tagId }; doneText = 'Usunięto tag'; break;
        case 'add_to_list': {
          let id = listId;
          if (newName.trim()) id = (await rpc('list_upsert', { p_list: { name: newName.trim() } })).id;
          if (id === null) throw new Error('no list');
          action = { action: 'add_to_list', listId: id }; doneText = 'Dodano do listy'; break;
        }
        case 'remove_from_list': if (listId === null) throw new Error('no list'); action = { action: 'remove_from_list', listId }; doneText = 'Usunięto z listy'; break;
        case 'set_validation': action = { action: 'set_validation', validation: validation === 'derived' ? null : validation }; doneText = 'Ustawiono status walidacji'; break;
        case 'set_dnc': action = { action: 'set_dnc', dnc: true, reason: reason.trim() || null }; doneText = 'Oznaczono „nie kontaktować”'; break;
        case 'clear_dnc': action = { action: 'set_dnc', dnc: false }; doneText = 'Zdjęto oznaczenie „nie kontaktować”'; break;
      }
      const res = await rpc('leads_bulk', { p_target: target, p_action: action });
      return { doneText, affected: res.affected };
    },
    onSuccess: ({ doneText, affected }) => {
      toast(`${doneText}: ${leadsPl(affected)}`);
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['ref'] });
      onDone();
    },
    onError: (e) => setError(errorText(e)),
  });

  const statusName = ref?.statuses.find((s) => s.id === statusId)?.name ?? '';
  const confirmText: Record<BulkKind, string> = {
    set_status: `Zmienić status ${leadsPl(count)} na „${statusName}”?`,
    set_owner: `Przypisać opiekuna (${ownerId === null ? 'brak' : ref?.members.find((x) => x.id === ownerId)?.displayName ?? ''}) do ${leadsPl(count)}?`,
    add_tag: `Dodać tag do ${leadsPl(count)}?`,
    remove_tag: `Usunąć tag z ${leadsPl(count)}?`,
    add_to_list: `Dodać ${leadsPl(count)} do listy?`,
    remove_from_list: `Usunąć ${leadsPl(count)} z listy?`,
    set_validation: `Ustawić status walidacji dla ${leadsPl(count)}?`,
    set_dnc: `Oznaczyć ${leadsPl(count)} jako „nie kontaktować”?`,
    clear_dnc: `Zdjąć oznaczenie „nie kontaktować” z ${leadsPl(count)}?`,
  };
  const lists = ref?.lists ?? [];
  const tags = ref?.tags ?? [];
  const canRun = kind === 'set_status' ? statusId > 0
    : kind === 'add_tag' ? Boolean(newName.trim()) || tagId !== null
    : kind === 'remove_tag' ? tagId !== null
    : kind === 'add_to_list' ? Boolean(newName.trim()) || listId !== null
    : kind === 'remove_from_list' ? listId !== null : true;

  return (
    <Modal title={KIND_LABEL[kind]} onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Anuluj</button>
        <button type="button" className="btn btn-primary" disabled={m.isPending || !canRun} onClick={() => m.mutate()}>{m.isPending ? 'Zapisywanie…' : 'Zastosuj'}</button>
      </>
    }>
      {kind === 'set_status' ? (
        <label className="field"><span className="field-label">Nowy status</span>
          <select value={statusId} onChange={(e) => setStatusId(Number(e.target.value))}>
            {(ref?.statuses ?? []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      ) : null}
      {kind === 'set_owner' ? (
        <label className="field"><span className="field-label">Opiekun</span>
          <select value={ownerId ?? ''} onChange={(e) => setOwnerId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">(bez opiekuna)</option>
            {(ref?.members ?? []).filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}
          </select>
        </label>
      ) : null}
      {kind === 'add_tag' || kind === 'remove_tag' ? (
        <>
          <label className="field"><span className="field-label">Tag</span>
            <select value={tagId ?? ''} onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : null)}>
              {tags.length === 0 ? <option value="">(brak tagów)</option> : null}
              {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          {kind === 'add_tag' ? <label className="field"><span className="field-label">…albo nowy tag</span><input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} /></label> : null}
        </>
      ) : null}
      {kind === 'add_to_list' || kind === 'remove_from_list' ? (
        <>
          <label className="field"><span className="field-label">Lista</span>
            <select value={listId ?? ''} onChange={(e) => setListId(e.target.value ? Number(e.target.value) : null)}>
              {lists.length === 0 ? <option value="">(brak list)</option> : null}
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.members})</option>)}
            </select>
          </label>
          {kind === 'add_to_list' ? <label className="field"><span className="field-label">…albo nowa lista</span><input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} /></label> : null}
        </>
      ) : null}
      {kind === 'set_validation' ? (
        <label className="field"><span className="field-label">Status walidacji</span>
          <select value={String(validation)} onChange={(e) => setValidation(e.target.value === 'derived' ? 'derived' : (Number(e.target.value) as ValidationStatus))}>
            {Object.entries(VALIDATION_PL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            <option value="derived">Wróć do wyliczonego automatycznie</option>
          </select>
        </label>
      ) : null}
      {kind === 'set_dnc' ? <label className="field"><span className="field-label">Powód (opcjonalnie)</span><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></label> : null}
      <p><strong>{confirmText[kind]}</strong></p>
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
    </Modal>
  );
}
