import { useMemo, useState } from 'react';
import type { LeadRow } from '../../lib/contract';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/common';
import { defaultNetworkName, entriesByAccount } from './grouping';
import { useNetworks } from './hooks';

export interface NetworkChoice { networkId?: number; newNetworkName?: string; memberKeys: string[] }

/** "Potwierdź sieć": choose an existing network or create one (default name = largest member), untick members. */
export function NetworkDialog({ entries, memberKeys, onConfirm, onClose, busy }: {
  entries: readonly LeadRow[]; memberKeys: readonly string[]; onConfirm: (c: NetworkChoice) => void; onClose: () => void; busy?: boolean;
}) {
  const networks = useNetworks();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState(() => defaultNetworkName(entries, memberKeys));
  const [existing, setExisting] = useState<number | ''>('');
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(memberKeys));
  const groups = useMemo(() => entriesByAccount(entries, memberKeys), [entries, memberKeys]);
  const picked = [...ticked];
  const valid = mode === 'new' ? name.trim().length > 0 && picked.length >= 2 : existing !== '' && picked.length >= 1;

  const toggle = (k: string) => setTicked((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  return (
    <Modal
      title="Potwierdź sieć"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Anuluj</button>
          <button
            type="button" className="btn btn-primary" disabled={!valid || busy}
            onClick={() => onConfirm(mode === 'new' ? { newNetworkName: name.trim(), memberKeys: picked } : { networkId: Number(existing), memberKeys: picked })}
          >Zapisz sieć</button>
        </>
      }
    >
      <p className="hint">Sieć to grupa podmiotów należących do jednego właściciela lub jednej marki. Odznacz te wpisy, które do niej nie należą.</p>
      <fieldset>
        <legend className="sr-only">Sieć docelowa</legend>
        <label className="inline"><input type="radio" name="net-mode" checked={mode === 'new'} onChange={() => setMode('new')} /> Nowa sieć</label>
        {mode === 'new' ? <Field label="Nazwa sieci"><input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></Field> : null}
        <label className="inline"><input type="radio" name="net-mode" checked={mode === 'existing'} onChange={() => setMode('existing')} /> Dodaj do istniejącej sieci</label>
        {mode === 'existing' ? (
          <Field label="Sieć">
            <select value={existing} onChange={(e) => setExisting(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">— wybierz —</option>
              {(networks.data ?? []).map((n) => <option key={n.id} value={n.id}>{n.name} ({n.accounts})</option>)}
            </select>
          </Field>
        ) : null}
      </fieldset>
      <h4>Wpisy w sieci</h4>
      <ul className="val-pick">
        {groups.map((g) => (
          <li key={g.key}>
            <label>
              <input type="checkbox" checked={ticked.has(g.key)} onChange={() => toggle(g.key)} />
              <span>{g.entries.map((e) => e.name ?? '(bez nazwy)').join(' + ') || g.key}<span className="muted"> — {g.entries[0]?.miasto ?? ''}</span></span>
            </label>
          </li>
        ))}
      </ul>
      {mode === 'new' && picked.length < 2 ? <p className="hint">Sieć wymaga co najmniej dwóch wpisów.</p> : null}
    </Modal>
  );
}
