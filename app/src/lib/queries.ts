import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { DictEntry, FacetKey, RefData } from './contract';
import { rpc } from './api';

/** Statuses, tags, members, views, lists, last import, settings (cached, stale after 5 min). */
export function useRefData() {
  return useQuery({ queryKey: ['ref'], queryFn: () => rpc('ref_data', {}), staleTime: 5 * 60_000, placeholderData: keepPreviousData });
}

export function useRefOrNull(): RefData | null {
  return useRefData().data ?? null;
}

const DICT_FACETS = ['p.spec', 'p.fn', 'p.grp', 'p.dz', 'p.rodzaje', 'r.spec', 'r.gz', 'r.zakres'];

/** Labels of register values (`kod — nazwa` for specialities, names for functions, groups…). */
export function useDict() {
  const q = useQuery({ queryKey: ['dict'], queryFn: () => rpc('dict', { p_facets: DICT_FACETS }), staleTime: 60 * 60_000 });
  const map = useMemo(() => {
    const m = new Map<string, Map<string, string>>();
    for (const e of q.data ?? ([] as DictEntry[])) {
      let inner = m.get(e.facet);
      if (!inner) m.set(e.facet, (inner = new Map()));
      if (e.label) inner.set(e.val, e.label);
    }
    return m;
  }, [q.data]);
  const label = useMemo(() => (facet: FacetKey | string, val: string) => map.get(facet)?.get(val) ?? val, [map]);
  return { label, loaded: q.isSuccess };
}

export function statusName(ref: Pick<RefData, 'statuses'> | null, id: number | null | undefined): string {
  if (id === null || id === undefined) return '–';
  return ref?.statuses.find((s) => s.id === id)?.name ?? `#${id}`;
}

export function memberName(ref: Pick<RefData, 'members'> | null, id: number | null | undefined): string {
  if (id === null || id === undefined) return '–';
  return ref?.members.find((m) => m.id === id)?.displayName ?? `#${id}`;
}
