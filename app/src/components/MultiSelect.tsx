import { useMemo, useState } from 'react';
import { fmtNum } from '../lib/format';

export interface Option { value: string; label: string; count?: number; depth?: number }

interface Props {
  title: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  cap?: number;
  defaultOpen?: boolean;
  onOpen?: () => void;
  note?: string;
}

const strip = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0142/g, 'l');

/** Searchable multi-select with per-option counts and "all / none / invert" (SPEC 4.2). */
export function MultiSelect({ title, options, selected, onChange, loading, cap = 300, defaultOpen, onOpen, note }: Props) {
  const [q, setQ] = useState('');
  const sel = useMemo(() => new Set(selected), [selected]);
  const visible = useMemo<Option[]>(() => {
    const n = strip(q.trim());
    const all = n ? options.filter((o) => strip(o.label).includes(n)) : options;
    // selected options that are not in the (possibly filtered) list stay visible so they can be unticked
    const missing = selected.filter((v) => !options.some((o) => o.value === v)).map((v) => ({ value: v, label: v }));
    return [...missing, ...all];
  }, [options, q, selected]);
  const shown = visible.slice(0, cap);
  const toggle = (v: string) => onChange(sel.has(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <details className="facet" open={defaultOpen} onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) onOpen?.(); }}>
      <summary>
        {title}
        {selected.length ? <span className="badge badge-blue">{selected.length}</span> : null}
      </summary>
      <div className="facet-body">
        {note ? <p className="hint">{note}</p> : null}
        {options.length > 8 ? (
          <input type="search" placeholder="Szukaj…" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Szukaj w: ${title}`} />
        ) : null}
        <div className="facet-tools">
          <button type="button" className="link" onClick={() => onChange([...new Set([...selected, ...shown.map((o) => o.value)])])}>Zaznacz wszystko</button>
          <button type="button" className="link" onClick={() => onChange([])}>Wyczyść</button>
          <button type="button" className="link" onClick={() => onChange(shown.filter((o) => !sel.has(o.value)).map((o) => o.value))}>Odwróć</button>
        </div>
        {loading ? <p className="muted">Wczytywanie…</p> : null}
        {!loading && options.length === 0 ? <p className="muted">Brak wartości dla bieżących filtrów.</p> : null}
        <ul className="facet-list">
          {shown.map((o) => (
            <li key={o.value} style={{ paddingLeft: (o.depth ?? 0) * 12 }}>
              <label>
                <input type="checkbox" checked={sel.has(o.value)} onChange={() => toggle(o.value)} />
                <span className="facet-label">{o.label}</span>
                {o.count !== undefined ? <span className="facet-count">{fmtNum(o.count)}</span> : null}
              </label>
            </li>
          ))}
        </ul>
        {visible.length > shown.length ? <p className="hint">Pokazano {shown.length} z {visible.length}. Zawęź wyszukiwaniem.</p> : null}
      </div>
    </details>
  );
}
