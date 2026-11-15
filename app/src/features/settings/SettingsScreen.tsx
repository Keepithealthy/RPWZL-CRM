import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DbUsage, LeadStatus, Tag, ValidationParams } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { fmtNum } from '../../lib/format';
import { useRefData } from '../../lib/queries';
import { ErrorBox, Field, PageHeader, Spinner } from '../../components/common';
import { Modal } from '../../components/Modal';
import { useUi } from '../../components/ui';
import { BackupPanel } from '../backup/BackupPanel';

export default function SettingsScreen() {
  return (
    <div>
      <PageHeader title="Ustawienia" help="Tylko dla właściciela. Zmiany działają od razu dla całego zespołu." />
      <StatusesPanel />
      <TagsPanel />
      <ValidationPanel />
      <GeneralPanel />
      <UsagePanel />
      <BackupPanel />
    </div>
  );
}

const useRefresh = () => {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: ['ref'] }); void qc.invalidateQueries({ queryKey: ['settings'] }); void qc.invalidateQueries({ queryKey: ['leads'] }); };
};

const STAGE_PL = { open: 'w toku', won: 'wygrany', lost: 'przegrany', paused: 'wstrzymany' } as const;

function StatusesPanel() {
  const ref = useRefData().data;
  const refresh = useRefresh();
  const { toast } = useUi();
  const [edit, setEdit] = useState<Partial<LeadStatus> | null>(null);
  const [del, setDel] = useState<LeadStatus | null>(null);
  const statuses = [...(ref?.statuses ?? [])].sort((a, b) => a.sort - b.sort);
  const move = useMutation({
    mutationFn: async ({ s, dir }: { s: LeadStatus; dir: -1 | 1 }) => {
      const i = statuses.findIndex((x) => x.id === s.id);
      const other = statuses[i + dir];
      if (!other) return;
      await rpc('status_upsert', { p_status: { ...s, sort: other.sort } });
      await rpc('status_upsert', { p_status: { ...other, sort: s.sort } });
    },
    onSuccess: refresh,
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <section className="panel" aria-labelledby="st-h">
      <h2 id="st-h">Statusy lejka</h2>
      <p className="hint">Kolejne etapy pracy z leadem. Domyślny status dostają wszystkie nowe leady. Etap („w toku / wygrany / przegrany / wstrzymany”) służy do raportowania.</p>
      <div className="table-wrap">
      <table className="grid small">
        <thead><tr><th>Kolejność</th><th>Nazwa</th><th>Etap</th><th>Domyślny</th><th>Aktywny</th><th /></tr></thead>
        <tbody>
          {statuses.map((s, i) => (
            <tr key={s.id}>
              <td><button type="button" className="btn-icon" aria-label={`W górę: ${s.name}`} disabled={i === 0} onClick={() => move.mutate({ s, dir: -1 })}>↑</button><button type="button" className="btn-icon" aria-label={`W dół: ${s.name}`} disabled={i === statuses.length - 1} onClick={() => move.mutate({ s, dir: 1 })}>↓</button></td>
              <td><span className="status-dot" style={{ ['--c' as string]: s.color }}>{s.name}</span></td>
              <td>{STAGE_PL[s.stage]}</td><td>{s.isDefault ? 'tak' : ''}</td><td>{s.active ? 'tak' : 'nie'}</td>
              <td className="actions"><button type="button" className="link" onClick={() => setEdit(s)}>Edytuj</button>{!s.isDefault ? <button type="button" className="link" onClick={() => setDel(s)}>Usuń</button> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <button type="button" className="btn" onClick={() => setEdit({ color: '#6b7280', stage: 'open', active: true, sort: (statuses.at(-1)?.sort ?? 0) + 1 })}>Dodaj status</button>
      {edit ? <StatusDialog initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} /> : null}
      {del ? <DeleteStatusDialog status={del} others={statuses.filter((s) => s.id !== del.id && s.active)} onClose={() => setDel(null)} onDone={() => { setDel(null); refresh(); }} /> : null}
    </section>
  );
}

function StatusDialog({ initial, onClose, onSaved }: { initial: Partial<LeadStatus>; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const [name, setName] = useState(initial.name ?? '');
  const [color, setColor] = useState(initial.color ?? '#6b7280');
  const [stage, setStage] = useState<LeadStatus['stage']>(initial.stage ?? 'open');
  const [isDefault, setIsDefault] = useState(initial.isDefault ?? false);
  const [active, setActive] = useState(initial.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => rpc('status_upsert', { p_status: { ...initial, name: name.trim(), color, stage, isDefault, active } }),
    onSuccess: () => { toast('Zapisano status'); onSaved(); },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal title={initial.id ? 'Edytuj status' : 'Nowy status'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Anuluj</button><button type="button" className="btn btn-primary" disabled={!name.trim() || m.isPending} onClick={() => m.mutate()}>Zapisz</button></>}>
      <Field label="Nazwa"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus /></Field>
      <Field label="Kolor"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></Field>
      <Field label="Etap"><select value={stage} onChange={(e) => setStage(e.target.value as LeadStatus['stage'])}>{Object.entries(STAGE_PL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <label className="check"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Domyślny dla nowych leadów</label>
      <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Aktywny (można go wybierać)</label>
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
    </Modal>
  );
}

function DeleteStatusDialog({ status, others, onClose, onDone }: { status: LeadStatus; others: LeadStatus[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useUi();
  const [to, setTo] = useState(others.find((o) => o.isDefault)?.id ?? others[0]?.id ?? 0);
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => rpc('status_delete', { p_id: status.id, p_reassign_to: to }),
    onSuccess: (r) => { toast(`Usunięto status; przeniesiono leadów: ${fmtNum(r.reassigned)}`); onDone(); },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal title={`Usuń status „${status.name}”`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Anuluj</button><button type="button" className="btn btn-danger" disabled={!to || m.isPending} onClick={() => m.mutate()}>Usuń i przenieś leady</button></>}>
      <p>Leady z tym statusem trafią do wybranego statusu. Historia zmian zostaje. Tej operacji nie można cofnąć.</p>
      <Field label="Przenieś leady do statusu"><select value={to} onChange={(e) => setTo(Number(e.target.value))}>{others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
    </Modal>
  );
}

function TagsPanel() {
  const ref = useRefData().data;
  const refresh = useRefresh();
  const { toast, confirm } = useUi();
  const [name, setName] = useState('');
  const [rename, setRename] = useState<Tag | null>(null);
  const [newName, setNewName] = useState('');
  const add = useMutation({
    mutationFn: (t: Partial<Tag> & { name: string }) => rpc('tag_upsert', { p_tag: t }),
    onSuccess: () => { toast('Zapisano tag'); setName(''); setRename(null); refresh(); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const del = useMutation({
    mutationFn: (id: number) => rpc('tag_delete', { p_id: id }),
    onSuccess: () => { toast('Usunięto tag'); refresh(); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <section className="panel" aria-labelledby="tag-h">
      <h2 id="tag-h">Tagi</h2>
      <ul className="plain">
        {(ref?.tags ?? []).map((t) => (
          <li key={t.id}>
            {rename?.id === t.id ? (
              <span className="inline"><input aria-label="Nowa nazwa tagu" value={newName} onChange={(e) => setNewName(e.target.value)} /><button type="button" className="btn btn-sm" disabled={!newName.trim()} onClick={() => add.mutate({ id: t.id, name: newName.trim(), color: t.color })}>Zapisz</button><button type="button" className="link" onClick={() => setRename(null)}>Anuluj</button></span>
            ) : (
              <>{t.name} <button type="button" className="link" onClick={() => { setRename(t); setNewName(t.name); }}>Zmień nazwę</button>
                <button type="button" className="link" onClick={async () => { if (await confirm(`Usunąć tag „${t.name}” ze wszystkich leadów? Tej operacji nie można cofnąć.`, { danger: true, confirmLabel: 'Usuń' })) del.mutate(t.id); }}>Usuń</button></>
            )}
          </li>
        ))}
        {(ref?.tags ?? []).length === 0 ? <li className="muted">Brak tagów.</li> : null}
      </ul>
      <div className="inline"><input aria-label="Nowy tag" placeholder="Nowy tag" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /><button type="button" className="btn" disabled={!name.trim()} onClick={() => add.mutate({ name: name.trim() })}>Dodaj tag</button></div>
    </section>
  );
}

function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => rpc('settings_get', {}) });
}

function useSetSetting() {
  const refresh = useRefresh();
  const { toast } = useUi();
  return useMutation({
    mutationFn: (v: { key: string; value: unknown }) => rpc('setting_set', { p_key: v.key, p_value: v.value }),
    onSuccess: () => { toast('Zapisano ustawienie'); refresh(); },
    onError: (e) => toast(errorText(e), 'error'),
  });
}

function ValidationPanel() {
  const q = useSettings();
  const set = useSetSetting();
  const refresh = useRefresh();
  const { toast } = useUi();
  const [params, setParams] = useState<ValidationParams | null>(null);
  const [minConf, setMinConf] = useState<number | null>(null);
  const domains = useQuery({ queryKey: ['settings', 'domains'], queryFn: () => rpc('val_decisions', {}) });
  const [dom, setDom] = useState('');
  const [kind, setKind] = useState<'free' | 'generic' | 'typo' | 'social'>('generic');
  const upsertDomain = useMutation({
    mutationFn: (v: { domain: string; kind: typeof kind | null }) => rpc('generic_domain_upsert', { p_domain: v.domain, p_kind: v.kind, p_suggestion: null }),
    onSuccess: () => { toast('Zapisano domenę'); setDom(''); void domains.refetch(); refresh(); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorBox error={q.error} />;
  const p = params ?? q.data.params;
  const mc = minConf ?? q.data.settings.valMinConfidence;
  const num = (key: keyof Omit<ValidationParams, 'staleBefore'>, label: string) => (
    <Field label={label} key={key}><input type="number" min={1} value={p[key]} onChange={(e) => setParams({ ...p, [key]: Number(e.target.value) })} /></Field>
  );
  return (
    <section className="panel" aria-labelledby="val-h">
      <h2 id="val-h">Walidacja</h2>
      <p className="hint">Progi, według których system proponuje powiązania („kto jest kim”). Zmiany działają przy następnym imporcie.</p>
      <Field label="Najniższa pewność pokazywana w Walidacji (0–100)"><input type="number" min={0} max={100} value={mc} onChange={(e) => setMinConf(Number(e.target.value))} /></Field>
      <button type="button" className="btn btn-sm" disabled={set.isPending || minConf === null} onClick={() => set.mutate({ key: 'val.minConfidence', value: mc })}>Zapisz próg pewności</button>
      <div className="grid-fields">
        {num('genericDomainAccounts', 'Domena firmowa używana przez tyle kont (w ≥ 3 województwach) jest „ogólna”')}
        {num('emailClusterMax', 'Maks. kont dzielących jeden e-mail w propozycji')}
        {num('domainClusterMax', 'Maks. kont z jedną domeną e-mail w propozycji')}
        {num('wwwClusterMax', 'Maks. kont z jedną stroną www w propozycji')}
        {num('phoneClusterMax', 'Maks. kont dzielących jeden telefon (powyżej: centrala)')}
      </div>
      <button type="button" className="btn btn-sm" disabled={set.isPending || params === null} onClick={() => set.mutate({ key: 'val.params', value: p })}>Zapisz progi</button>

      <h3>Domeny ogólne (nie służą do łączenia kont)</h3>
      <div className="table-wrap">
      <table className="grid small">
        <thead><tr><th>Domena</th><th>Rodzaj</th><th /></tr></thead>
        <tbody>
          {(domains.data?.genericDomains ?? []).slice(0, 100).map((d) => (
            <tr key={d.domain}><td>{d.domain}</td><td>{{ free: 'darmowa poczta', generic: 'ogólna', typo: 'literówka', social: 'serwis społecznościowy' }[d.kind]}</td>
              <td className="actions"><button type="button" className="link" onClick={() => upsertDomain.mutate({ domain: d.domain, kind: null })}>Usuń</button></td></tr>
          ))}
        </tbody>
      </table>
      </div>
      {(domains.data?.genericDomains.length ?? 0) > 100 ? <p className="hint">Pokazano 100 z {fmtNum(domains.data?.genericDomains.length)}.</p> : null}
      <div className="inline">
        <input aria-label="Domena" placeholder="np. gmail.com" value={dom} onChange={(e) => setDom(e.target.value)} />
        <select aria-label="Rodzaj domeny" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="free">darmowa poczta</option><option value="generic">ogólna</option><option value="typo">literówka</option><option value="social">serwis społecznościowy</option></select>
        <button type="button" className="btn" disabled={!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(dom.trim())} onClick={() => upsertDomain.mutate({ domain: dom.trim().toLowerCase(), kind })}>Dodaj domenę</button>
      </div>
    </section>
  );
}

function GeneralPanel() {
  const q = useSettings();
  const set = useSetSetting();
  const [stale, setStale] = useState<number | null>(null);
  const [keep, setKeep] = useState(24);
  if (!q.data) return null;
  const s = q.data.settings;
  return (
    <section className="panel" aria-labelledby="gen-h">
      <h2 id="gen-h">Ogólne</h2>
      <Field label="SMS: polskie znaki domyślnie" hint="„Usuń” zamienia ą→a itd. — mieści się więcej tekstu w jednym SMS.">
        <select value={s.smsDiacritics} onChange={(e) => set.mutate({ key: 'sms.diacritics', value: e.target.value })}><option value="keep">zostaw</option><option value="strip">usuń</option></select>
      </Field>
      <Field label="Ostrzeżenie, gdy dane z rejestru są starsze niż (dni)"><input type="number" min={1} value={stale ?? s.staleDays} onChange={(e) => setStale(Number(e.target.value))} /></Field>
      <button type="button" className="btn btn-sm" disabled={stale === null || set.isPending} onClick={() => set.mutate({ key: 'ui.staleDays', value: stale })}>Zapisz</button>
      <Field label="Historia rejestru: ile ostatnich importów przechowywać" hint="Domyślnie 24. Mniej = mniej miejsca w bazie (ok. 7 MB mniej przy 12).">
        <input type="number" min={1} max={60} value={keep} onChange={(e) => setKeep(Number(e.target.value))} />
      </Field>
      <button type="button" className="btn btn-sm" disabled={set.isPending} onClick={() => set.mutate({ key: 'history.keepRuns', value: keep })}>Zapisz</button>
    </section>
  );
}

function UsagePanel() {
  const q = useQuery<DbUsage>({ queryKey: ['db_usage'], queryFn: () => rpc('db_usage', {}), staleTime: 60_000 });
  const mb = (b: number) => b / 1_048_576;
  return (
    <section className="panel" aria-labelledby="use-h">
      <h2 id="use-h">Miejsce w bazie</h2>
      {q.isPending ? <Spinner /> : null}
      {q.isError ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data ? (
        <>
          <p><strong>Zajęte {fmtNum(Math.round(mb(q.data.bytes)))} MB z {fmtNum(Math.round(mb(q.data.limitBytes)))} MB</strong></p>
          <progress max={q.data.limitBytes} value={q.data.bytes} aria-label="Zajęte miejsce w bazie" />
          {q.data.dictValues !== undefined && q.data.dictLimit !== undefined ? (
            <p className="hint">Słownik wartości rejestru: {fmtNum(q.data.dictValues)} z {fmtNum(q.data.dictLimit)} (zwykle ok. 3,5 tys.). Gdy się zapełni, import zatrzyma się z komunikatem — wtedy skontaktuj się z administratorem.</p>
          ) : null}
          <p className="hint">Po przekroczeniu 500 MB darmowy plan Supabase przestaje przyjmować zapisy (CRM działa tylko do odczytu). Import jest blokowany już powyżej 450 MB. Gdy zbliżasz się do limitu: zmniejsz historię rejestru (niżej) lub napisz do programisty.</p>
          <table className="grid small"><caption>Największe tabele</caption><thead><tr><th>Tabela</th><th>MB</th></tr></thead>
            <tbody>{q.data.tables.map((t) => <tr key={t.name}><td>{t.name}</td><td>{fmtNum(Math.round(mb(t.bytes)))}</td></tr>)}</tbody></table>
        </>
      ) : null}
    </section>
  );
}
