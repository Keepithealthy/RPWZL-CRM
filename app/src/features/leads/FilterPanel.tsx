import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ENTITY_TYPE_PL, P_FACETS, R_FACETS, VALIDATION_PL, type EntityType, type FacetKey, type LeadFilter, type NipStatus, type ValidationStatus } from '../../lib/contract';
import { rpc } from '../../lib/api';
import { cleanFilter } from '../../lib/filterCodec';
import { FACET_TITLE, VALUE_LABEL } from '../../lib/describeFilter';
import { useDict, useRefData } from '../../lib/queries';
import { MultiSelect, type Option } from '../../components/MultiSelect';
import { todayIso } from '../../lib/format';

interface Props { filter: LeadFilter; onChange: (f: LeadFilter) => void }

const NUM_FACETS_NOTE: Partial<Record<FacetKey, string>> = {
  'p.status': 'Domyślnie warto zostawić „aktywny”. Nierozpoczęte i zakończone nie mają aktywnych zakładów.',
};

/** Prefix nodes for the function tree: selecting 'HC.1.' matches the whole subtree (CONTRACT 4). */
export function fnOptions(values: Array<[string, number]>, label: (v: string) => string): Option[] {
  const leaves = new Map(values);
  const nodes = new Set<string>();
  for (const [v] of values) {
    const parts = v.split('.').filter(Boolean);
    for (let i = 1; i < parts.length; i++) nodes.add(parts.slice(0, i).join('.') + '.');
  }
  const all = [...new Set([...nodes, ...leaves.keys()])].sort();
  return all.map((v) => ({
    value: v,
    label: `${v} ${label(v) === v ? '' : '— ' + label(v)}`.trim(),
    count: leaves.get(v),
    depth: Math.max(0, v.split('.').filter(Boolean).length - 1),
  }));
}

function FacetBox({ k, filter, onChange }: { k: FacetKey; filter: LeadFilter; onChange: (f: LeadFilter) => void }) {
  const [opened, setOpened] = useState(false);
  const dict = useDict();
  const sel = filter.sel?.[k] ?? [];
  const q = useQuery({
    queryKey: ['facets', k, filter],
    enabled: opened,
    staleTime: 60_000,
    queryFn: () => rpc('leads_facets', { p_filter: filter, p_facets: [k] }),
  });
  const options = useMemo<Option[]>(() => {
    const vals = q.data?.[k] ?? [];
    const lab = (v: string) => VALUE_LABEL[k]?.[v] ?? dict.label(k, v);
    if (k === 'p.fn') return fnOptions(vals, lab);
    const opts = vals.map(([v, count]) => ({ value: v, label: lab(v), count }));
    return k === 'p.spec' || k === 'r.spec' ? opts.sort((a, b) => a.value.localeCompare(b.value)) : opts.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  }, [q.data, k, dict]);
  return (
    <MultiSelect
      title={FACET_TITLE[k]}
      options={options}
      selected={sel}
      loading={opened && q.isPending}
      cap={k === 'p.spec' || k === 'p.fn' ? 1000 : 300}
      note={NUM_FACETS_NOTE[k]}
      onOpen={() => setOpened(true)}
      defaultOpen={sel.length > 0}
      onChange={(next) => onChange({ ...filter, sel: { ...filter.sel, [k]: next } })}
    />
  );
}

function Section({ title, children, open }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="fsection" open={open}>
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}

export function FilterPanel({ filter, onChange }: Props) {
  const ref = useRefData().data;
  const kind = filter.kind ?? 'all';
  const patch = (p: Partial<LeadFilter>) => onChange(cleanFilter({ ...filter, ...p }));
  const contact = filter.contact ?? {};
  const setContact = (key: keyof NonNullable<LeadFilter['contact']>, v: boolean) => patch({ contact: { ...contact, [key]: v } });

  const statusOpts = (ref?.statuses ?? []).filter((s) => s.active).map((s) => ({ value: String(s.id), label: s.name }));
  const ownerOpts: Option[] = [
    { value: 'me', label: 'Ja' },
    { value: 'none', label: 'Bez opiekuna' },
    ...(ref?.members ?? []).filter((m) => m.active).map((m) => ({ value: String(m.id), label: m.displayName })),
  ];
  const tagOpts = (ref?.tags ?? []).map((t) => ({ value: String(t.id), label: t.name }));
  const parseOwner = (v: string): number | 'me' | 'none' => (v === 'me' || v === 'none' ? v : Number(v));

  return (
    <div className="filters">
      <div className="filters-head">
        <strong>Filtry</strong>
        <button type="button" className="link" onClick={() => onChange({})}>Wyczyść wszystkie filtry</button>
      </div>

      <fieldset className="kind-switch">
        <legend className="sr-only">Rodzaj wpisów</legend>
        {([['all', 'Wszystkie'], ['p', 'Podmioty lecznicze'], ['r', 'Praktyki zawodowe']] as const).map(([v, l]) => (
          <label key={v}><input type="radio" name="kind" checked={kind === v} onChange={() => patch({ kind: v })} /> {l}</label>
        ))}
      </fieldset>
      {kind === 'all' ? <p className="hint">Filtry podmiotów nie ukrywają praktyk (i odwrotnie).</p> : null}

      {kind !== 'r' ? (
        <Section title="Podmioty lecznicze" open>
          {P_FACETS.map((k) => <FacetBox key={k} k={k} filter={filter} onChange={onChange} />)}
          <div className="field">
            <span className="field-label">Liczba różnych poradni specjalistycznych (min.)</span>
            <div className="chips">
              {[undefined, 3, 5, 10].map((n) => (
                <button key={String(n)} type="button" className={`chip${filter.spec1Min === n || (!filter.spec1Min && n === undefined) ? ' on' : ''}`} onClick={() => patch({ spec1Min: n })}>{n ?? 'dowolna'}</button>
              ))}
            </div>
          </div>
          <label className="field"><span className="field-label">Liczba komórek (min.)</span>
            <input type="number" min={0} value={filter.nkMin ?? ''} onChange={(e) => patch({ nkMin: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
        </Section>
      ) : null}

      {kind !== 'p' ? (
        <Section title="Praktyki zawodowe" open={kind === 'r'}>
          {R_FACETS.map((k) => <FacetBox key={k} k={k} filter={filter} onChange={onChange} />)}
        </Section>
      ) : null}

      <Section title="Kontakt, daty, typ" open>
        <label className="field"><span className="field-label">Miejscowość (zawiera)</span>
          <input type="search" value={filter.miasto ?? ''} onChange={(e) => patch({ miasto: e.target.value || undefined })} />
        </label>
        <fieldset className="checks">
          <legend>Kontakt</legend>
          {([['email', 'ma e-mail'], ['tel', 'ma telefon'], ['mobile', 'ma komórkę'], ['www', 'ma stronę www'], ['nip', 'ma NIP']] as const).map(([k, l]) => (
            <label key={k}><input type="checkbox" checked={Boolean(contact[k])} onChange={(e) => setContact(k, e.target.checked)} /> {l}</label>
          ))}
        </fieldset>
        <div className="field">
          <span className="field-label">Data wpisu do rejestru</span>
          <div className="chips">
            {([[undefined, 'dowolna'], [1, 'ostatni miesiąc'], [6, '6 miesięcy'], [12, '12 miesięcy']] as const).map(([n, l]) => (
              <button key={l} type="button" className={`chip${filter.wpisRel === n || (!filter.wpisRel && n === undefined) ? ' on' : ''}`} onClick={() => patch({ wpisRel: n })}>{l}</button>
            ))}
          </div>
          <div className="row2">
            <input type="date" aria-label="Wpis od" value={filter.wpisOd ?? ''} max={todayIso()} onChange={(e) => patch({ wpisOd: e.target.value || undefined, wpisRel: undefined })} />
            <input type="date" aria-label="Wpis do" value={filter.wpisDo ?? ''} max={todayIso()} onChange={(e) => patch({ wpisDo: e.target.value || undefined, wpisRel: undefined })} />
          </div>
        </div>
        <label className="field"><span className="field-label">Ostatnia zmiana wpisu od dnia</span>
          <input type="date" value={filter.stanOd ?? ''} onChange={(e) => patch({ stanOd: e.target.value || undefined })} />
        </label>
        <MultiSelect title="Typ podmiotu" options={(Object.entries(ENTITY_TYPE_PL)).map(([v, l]) => ({ value: v, label: l }))}
          selected={(filter.entityType ?? []).map(String)} onChange={(n) => patch({ entityType: n.map(Number) as EntityType[] })} />
        <MultiSelect title="Problem z NIP" options={[{ value: '2', label: 'Zły format' }, { value: '3', label: 'Wartość zastępcza (np. 0000000000)' }, { value: '4', label: 'Błędna suma kontrolna' }, { value: '0', label: 'Brak NIP' }]}
          selected={(filter.nipStatus ?? []).map(String)} onChange={(n) => patch({ nipStatus: n.map(Number) as NipStatus[] })} />
        <label className="check"><input type="checkbox" checked={Boolean(filter.accountPrimaryOnly)} onChange={(e) => patch({ accountPrimaryOnly: e.target.checked })} /> Tylko główny wpis konta</label>
        <label className="field"><span className="field-label">W rejestrze</span>
          <select value={filter.inRegister ?? 'yes'} onChange={(e) => patch({ inRegister: e.target.value as 'yes' | 'no' | 'all' })}>
            <option value="yes">tak (domyślnie)</option><option value="no">zniknęły z rejestru</option><option value="all">wszystkie</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={filter.newInRun !== undefined} onChange={(e) => patch({ newInRun: e.target.checked ? 'last' : undefined })} /> Nowe w ostatnim imporcie</label>
        <label className="check"><input type="checkbox" checked={filter.changedInRun !== undefined} onChange={(e) => patch({ changedInRun: e.target.checked ? 'last' : undefined })} /> Zmienione w ostatnim imporcie</label>
      </Section>

      <Section title="CRM" open>
        <MultiSelect title="Status" options={statusOpts} selected={(filter.status ?? []).map(String)} onChange={(n) => patch({ status: n.map(Number) })} />
        <MultiSelect title="Opiekun" options={ownerOpts} selected={(filter.owner ?? []).map(String)} onChange={(n) => patch({ owner: n.map(parseOwner) })} />
        <MultiSelect title="Tagi" options={tagOpts} selected={(filter.tags ?? []).map(String)} onChange={(n) => patch({ tags: n.map(Number) })} />
        {(filter.tags?.length ?? 0) > 1 ? (
          <label className="field"><span className="field-label">Tagi: dopasuj</span>
            <select value={filter.tagsMode ?? 'any'} onChange={(e) => patch({ tagsMode: e.target.value as 'any' | 'all' })}><option value="any">dowolny</option><option value="all">wszystkie</option></select>
          </label>
        ) : null}
        <MultiSelect title="Status walidacji" options={(Object.entries(VALIDATION_PL)).map(([v, l]) => ({ value: v, label: l }))}
          selected={(filter.validation ?? []).map(String)} onChange={(n) => patch({ validation: n.map(Number) as ValidationStatus[] })} />
        <label className="field"><span className="field-label">Następny krok</span>
          <select value={filter.nextStep ?? ''} onChange={(e) => patch({ nextStep: (e.target.value || undefined) as LeadFilter['nextStep'] })}>
            <option value="">dowolny</option><option value="overdue">zaległy</option><option value="today">na dziś</option><option value="week">w ciągu 7 dni</option><option value="none">brak</option><option value="any">ustawiony</option>
          </select>
        </label>
        <label className="field"><span className="field-label">Nie kontaktować</span>
          <select value={filter.dnc ?? 'all'} onChange={(e) => patch({ dnc: e.target.value as 'all' | 'exclude' | 'only' })}>
            <option value="all">pokaż wszystkie</option><option value="exclude">ukryj oznaczone</option><option value="only">tylko oznaczone</option>
          </select>
        </label>
        <label className="field"><span className="field-label">Ostatni kontakt</span>
          <select value={filter.lastContact ?? ''} onChange={(e) => patch({ lastContact: (e.target.value || undefined) as LeadFilter['lastContact'] })}>
            <option value="">dowolny</option><option value="never">nigdy</option><option value="7d">do 7 dni temu</option><option value="30d">do 30 dni temu</option><option value="90d">do 90 dni temu</option><option value="older90">ponad 90 dni temu</option>
          </select>
        </label>
        <label className="field"><span className="field-label">Lista</span>
          <select value={filter.listId ?? ''} onChange={(e) => patch({ listId: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">dowolna</option>{(ref?.lists ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Sieć</span>
          <select value={String(filter.network ?? '')} onChange={(e) => patch({ network: e.target.value === '' ? undefined : e.target.value === 'any' || e.target.value === 'none' ? e.target.value : Number(e.target.value) })}>
            <option value="">dowolna</option><option value="any">w sieci</option><option value="none">bez sieci</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={Boolean(filter.openProposal)} onChange={(e) => patch({ openProposal: e.target.checked })} /> Ma otwartą propozycję walidacji</label>
      </Section>
    </div>
  );
}
