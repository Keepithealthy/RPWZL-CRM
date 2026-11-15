import { useNavigate } from 'react-router-dom';
import type { LeadRow, LeadSort, RefData, SortKey } from '../../lib/contract';
import { COLUMNS } from './columns';

interface Props {
  rows: LeadRow[];
  refData: RefData | null;
  columns: string[];
  sort: LeadSort | null;
  onSort: (key: SortKey) => void;
  selected: Set<number>;
  allSelected: boolean;
  onToggle: (id: number) => void;
  onTogglePage: (on: boolean) => void;
}

export function LeadsTable({ rows, refData, columns, sort, onSort, selected, allSelected, onToggle, onTogglePage }: Props) {
  const nav = useNavigate();
  const cols = COLUMNS.filter((c) => columns.includes(c.key));
  const effective = sort ?? { key: 'name' as const, dir: 'asc' as const };
  const pageAll = rows.length > 0 && rows.every((r) => allSelected || selected.has(r.id));
  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th className="col-check"><input type="checkbox" aria-label="Zaznacz wszystkie wiersze na stronie" checked={pageAll} onChange={(e) => onTogglePage(e.target.checked)} /></th>
            {cols.map((c) => {
              const active = c.sort && effective.key === c.sort;
              return (
                <th key={c.key} className={`col-${c.key}`} aria-sort={active ? (effective.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.sort ? (
                    <button type="button" className="th-sort" onClick={() => onSort(c.sort!)}>
                      {c.label}{active ? (effective.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  ) : c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              tabIndex={0}
              className={allSelected || selected.has(r.id) ? 'selected' : undefined}
              onClick={() => nav(`/lead/${r.id}`)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter') nav(`/lead/${r.id}`);
                if (e.key === ' ') { e.preventDefault(); onToggle(r.id); }
              }}
            >
              <td className="col-check" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" aria-label={`Zaznacz: ${r.name ?? r.id}`} checked={allSelected || selected.has(r.id)} onChange={() => onToggle(r.id)} />
              </td>
              {cols.map((c) => <td key={c.key} className={`col-${c.key}`}>{c.render(r, refData)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
