import { useState, type ReactNode } from 'react';
import { QFLAG, SOURCE_LABEL_PL, type LeadCard } from '../../lib/contract';
import { fmtDate, fmtNum } from '../../lib/format';
import { copyText } from '../../lib/links';
import { useDict } from '../../lib/queries';
import { useUi } from '../../components/ui';

/* The register detail `d` is untrusted JSON (offline tool SPEC V2.5.1). Everything is rendered as text. */
type Json = unknown;
const isObj = (x: Json): x is Record<string, Json> => typeof x === 'object' && x !== null && !Array.isArray(x);
const arr = (x: Json): Json[] => (Array.isArray(x) ? x : []);
const str = (x: Json): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '');
const strs = (x: Json): string[] => arr(x).filter((v): v is string => typeof v === 'string');

const ZAKRES = ['Diagnostyczny', 'Leczniczy', 'Rehabilitacyjny', 'Pielęgnacyjny', 'Edukacja zdrowotna i promocja zdrowia', 'Medyczne czynności ratunkowe',
  'Certyfikacja medyczna', 'Pozostały zakres', 'POCT (badania przyłóżkowe)', 'Pobieranie materiału do badań', 'Opinie i orzeczenia z medycyny laboratoryjnej'];
const AD_LABEL = ['Miejsce udzielania świadczeń', 'Miejsce wezwania', 'W zakładzie leczniczym', 'Przechowywanie dokumentacji'];

export const zakresLabels = (mask: number): string[] => ZAKRES.filter((_, i) => (mask & (1 << i)) !== 0);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="kv"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Copy({ value }: { value: string }) {
  const { toast } = useUi();
  return <button type="button" className="link" onClick={async () => toast((await copyText(value)) ? 'Skopiowano' : 'Nie udało się skopiować')} aria-label={`Kopiuj ${value}`}>kopiuj</button>;
}

function contactText(c: Json): string {
  const a = arr(c);
  const parts = [a[0] ? `e-mail: ${str(a[0])}` : '', a[1] ? `www: ${str(a[1])}` : '', a[2] ? `tel.: ${str(a[2])}` : ''].filter(Boolean);
  return parts.join(' · ');
}

function Capped<T>({ items, render, cap = 100 }: { items: T[]; render: (x: T, i: number) => ReactNode; cap?: number }) {
  const [n, setN] = useState(cap);
  return (
    <>
      {items.slice(0, n).map(render)}
      {items.length > n ? <button type="button" className="btn btn-sm" onClick={() => setN(n + cap)}>Pokaż więcej ({fmtNum(items.length - n)} pozostało)</button> : null}
    </>
  );
}

export function RegisterTab({ card }: { card: LeadCard }) {
  const dict = useDict();
  const { row, rec } = card;
  const d = rec?.d ?? null;
  const isP = row.kind === 'p';
  const refDate = card.lastChange?.reportDate ?? card.firstRun?.reportDate ?? null;

  return (
    <div className="register">
      <p className="hint">Źródło: {SOURCE_LABEL_PL[row.src]}{refDate ? `, raport z dnia ${fmtDate(refDate)}` : ''}. Dane tylko do odczytu — Wasze notatki i statusy są na pozostałych zakładkach.</p>

      <section><h3>Wpis w rejestrze</h3>
        <dl className="kvs">
          {row.nip && (row.qflags & QFLAG.GROUP_NIP_IS_PARTNER) !== 0
            ? <Row label="NIP">brak NIP praktyki (NIP wspólnika: {row.nip}) <Copy value={row.nip} /></Row>
            : row.nip ? <Row label="NIP">{row.nip} <Copy value={row.nip} /></Row> : null}
          <Row label="Księga rejestrowa nr">{card.ks} <Copy value={card.ks} /></Row>
          {card.org ? <Row label="Organ rejestrowy">{card.org}</Row> : null}
          <Row label="Data wpisu">{fmtDate(row.wpis)}</Row>
          {d ? <Row label="Ostatnia zmiana">{fmtDate(str(d.zm) || null)}</Row> : null}
          <Row label="Stan rekordu">{fmtDate(row.stan)}</Row>
          {d && str(d.st) ? <Row label="Rozpoczęcie działalności">{fmtDate(str(d.st))}</Row> : null}
          {d && str(d.en) ? <Row label="Zakończenie działalności">{fmtDate(str(d.en))}</Row> : null}
          {d && str(d.wykr) ? <Row label="Wykreślenie z rejestru">{fmtDate(str(d.wykr))}</Row> : null}
          {isP && d && str(d.tw) ? <Row label="Podmiot tworzący">{str(d.tw)}</Row> : null}
          {Object.entries(card.facets).filter(([k]) => ['p.forma', 'p.formType', 'r.forma', 'r.typ', 'r.grupaPraktyk', 'r.status', 'p.status'].includes(k)).map(([k, v]) => (
            <Row key={k} label={FACET_ROW[k] ?? k}>{(v ?? []).join(', ')}</Row>
          ))}
        </dl>
        {isP && d && arr(d.sc).length ? (
          <>
            <h4>Wspólnicy spółki cywilnej</h4>
            <ul>{arr(d.sc).map((p, i) => <li key={i}>{str(arr(p)[0]) || '(brak nazwy)'}{str(arr(p)[1]) ? ` — NIP ${str(arr(p)[1])}` : ''}</li>)}</ul>
          </>
        ) : null}
        {!isP && d && arr(d.zw).length ? (
          <>
            <h4>Zawieszenia działalności</h4>
            <ul>{arr(d.zw).map((p, i) => <li key={i}>{fmtDate(str(arr(p)[0]) || null)} – {str(arr(p)[1]) ? fmtDate(str(arr(p)[1])) : 'bezterminowo'}</li>)}</ul>
          </>
        ) : null}
      </section>

      <section><h3>Adresy</h3>
        <dl className="kvs">
          {d ? (
            <>
              {isP && str(d.sie) ? <Row label="Siedziba">{str(d.sie)}</Row> : null}
              {str(d.kor) ? <Row label="Korespondencja">{str(d.kor)}</Row> : null}
            </>
          ) : null}
          {!d || (!str(d.sie) && !str(d.kor)) ? <Row label="Adres">{[rec?.ulica, [card.kod, row.miasto].filter(Boolean).join(' '), row.woj ? `woj. ${row.woj}` : ''].filter(Boolean).join(', ') || '–'}</Row> : null}
          {d && contactText(d.c) ? <Row label="Kontakt (wpis)">{contactText(d.c)}</Row> : null}
        </dl>
      </section>

      {!rec || !d ? (
        <p className="muted">{rec ? 'Szczegóły tego rekordu są uszkodzone lub niedostępne.' : 'Brak szczegółów w bazie. Zaimportuj indeks w wersji 2.'}</p>
      ) : isP ? <PodmiotStructure card={card} d={d} labelOf={dict.label} /> : <PraktykaPerson card={card} d={d} />}

      <p className="hint">Jak znaleźć w rejestrze RPWDL: wyszukaj po numerze księgi {card.ks}{row.nip ? ` albo po NIP ${row.nip}` : ''}.</p>
    </div>
  );
}

const FACET_ROW: Record<string, string> = {
  'p.forma': 'Forma organizacyjno-prawna', 'p.formType': 'Typ formy', 'p.status': 'Status podmiotu', 'r.forma': 'Forma', 'r.typ': 'Typ praktyki',
  'r.grupaPraktyk': 'Grupa praktyk', 'r.status': 'Status wpisu',
};

function PodmiotStructure({ card, d, labelOf }: { card: LeadCard; d: Record<string, Json>; labelOf: (f: string, v: string) => string }) {
  const rec = card.rec!;
  const zs = arr(d.z).filter(isObj);
  const zx = typeof d.zx === 'number' ? d.zx : 0;
  const ctx: Ctx = { rodzaje: rec.rodzaje ?? [], dz: rec.dz ?? [], fn: rec.fn ?? [], labelOf };
  return (
    <section><h3>Struktura (aktywna)</h3>
      <dl className="kvs">
        <Row label="Zakłady">{fmtNum(card.row.nz)}{zx ? ` (oraz ${fmtNum(zx)} nieaktywnych)` : ''}</Row>
        <Row label="Komórki">{fmtNum(card.row.nk)}</Row>
        <Row label="Poradnie specjalistyczne (bez stomatologii)">{fmtNum(card.row.spec1)}</Row>
      </dl>
      {zs.length === 0 ? <p className="muted">Brak aktywnych zakładów w szczegółach wpisu.</p> : null}
      <Capped items={zs} cap={50} render={(z, i) => <Zaklad key={i} z={z} ctx={ctx} defaultOpen={i === 0} />} />
    </section>
  );
}

interface Ctx { rodzaje: string[]; dz: string[]; fn: string[]; labelOf: (f: string, v: string) => string }

function idxList(ix: Json, source: string[]): string[] {
  return arr(ix).map((i) => (typeof i === 'number' ? source[i] : undefined)).filter((v): v is string => Boolean(v));
}

function Zaklad({ z, ctx, defaultOpen }: { z: Record<string, Json>; ctx: Ctx; defaultOpen: boolean }) {
  const [opened, setOpened] = useState(defaultOpen);
  const rodzaj = typeof z.r === 'number' ? ctx.rodzaje[z.r] : undefined;
  const js = arr(z.j).filter(isObj);
  const ks = arr(z.k).filter(isObj);
  return (
    <details className="zaklad" open={defaultOpen} onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) setOpened(true); }}>
      <summary>{str(z.n) || '(zakład bez nazwy)'} <span className="muted">· jednostki: {js.length} · komórki bezpośrednie: {ks.length}</span></summary>
      {opened ? (
        <div className="zbody">
          <dl className="kvs">
            {rodzaj ? <Row label="Rodzaj">{rodzaj}</Row> : null}
            {str(z.rg) ? <Row label="REGON">{str(z.rg)}</Row> : null}
            {str(z.a) ? <Row label="Adres">{str(z.a)}</Row> : null}
            {contactText(z.c) ? <Row label="Kontakt">{contactText(z.c)}</Row> : null}
          </dl>
          <Capped items={js} cap={30} render={(j, i) => (
            <div key={i} className="jednostka">
              <h5>{str(j.n) || '(jednostka bez nazwy)'}</h5>
              <p className="muted">{[str(j.a), contactText(j.c), idxList(j.dz, ctx.dz).length ? `dziedziny: ${idxList(j.dz, ctx.dz).join(', ')}` : '', idxList(j.fn, ctx.fn).length ? `funkcje: ${idxList(j.fn, ctx.fn).map((f) => ctx.labelOf('p.fn', f)).join(', ')}` : ''].filter(Boolean).join(' · ')}</p>
              <Komorki items={arr(j.k).filter(isObj)} ctx={ctx} />
            </div>
          )} />
          {ks.length ? <><h5>Komórki</h5><Komorki items={ks} ctx={ctx} /></> : null}
        </div>
      ) : null}
    </details>
  );
}

function Komorki({ items, ctx }: { items: Array<Record<string, Json>>; ctx: Ctx }) {
  return (
    <ul className="komorki">
      <Capped items={items} cap={100} render={(k, i) => {
        const code = str(k.s);
        const dz = idxList(k.dz, ctx.dz);
        const fn = idxList(k.fn, ctx.fn);
        return (
          <li key={i}>
            <strong>{str(k.n) || '(komórka bez nazwy)'}</strong>
            {code ? <span> — {ctx.labelOf('p.spec', code)}</span> : null}
            <span className="muted">{[dz.length ? `dziedziny: ${dz.join(', ')}` : '', fn.length ? `funkcje: ${fn.map((f) => ctx.labelOf('p.fn', f)).join(', ')}` : '', contactText(k.c), str(k.a), typeof k.lo === 'number' ? `łóżka: ${k.lo}` : ''].filter(Boolean).map((t) => ` · ${t}`).join('')}</span>
          </li>
        );
      }} />
    </ul>
  );
}

function specsText(sp: Json): string[] {
  return arr(sp).map((p) => [str(arr(p)[0]), str(arr(p)[1]) ? `(${str(arr(p)[1])})` : ''].filter(Boolean).join(' ')).filter(Boolean);
}

function Activity({ a, rec }: { a: Record<string, Json>; rec: NonNullable<LeadCard['rec']> }) {
  const rodzaj = typeof a.t === 'number' ? rec.rodzaj?.[a.t] : undefined;
  const rd = typeof a.ta === 'number' ? rec.rd?.[a.ta] : undefined;
  const dz = strs(a.dz);
  const zk = typeof a.zk === 'number' ? zakresLabels(a.zk) : [];
  const rows = arr(a.ad);
  return (
    <div className="activity">
      <dl className="kvs">
        {rodzaj ? <Row label="Rodzaj praktyki">{rodzaj}</Row> : null}
        {rd ? <Row label="Rodzaj działalności">{rd}</Row> : null}
        {dz.length ? <Row label="Dziedziny">{dz.join(', ')}</Row> : null}
        {zk.length ? <Row label="Zakres świadczeń">{zk.join(', ')}</Row> : null}
        {rows.map((r, i) => {
          const x = arr(r);
          const kind = typeof x[0] === 'number' ? (AD_LABEL[x[0]] ?? 'Adres') : 'Adres';
          const extra = x[0] === 2 ? [str(x[3]), str(x[4]) ? `REGON ${str(x[4])}` : ''].filter(Boolean).join(', ') : '';
          return <Row key={i} label={kind}>{[str(x[1]), str(x[2]) ? `tel.: ${str(x[2])}` : '', extra].filter(Boolean).join(' · ') || '–'}</Row>;
        })}
      </dl>
    </div>
  );
}

function PraktykaPerson({ card, d }: { card: LeadCard; d: Record<string, Json> }) {
  const rec = card.rec!;
  const acts = arr(d.a).filter(isObj);
  const partners = arr(d.w).filter(isObj);
  const gz = card.facets['r.gz']?.join(', ');
  return (
    <>
      <section><h3>Osoba i działalność</h3>
        <dl className="kvs">
          {str(d.tyt) ? <Row label="Tytuł zawodowy">{str(d.tyt)}</Row> : null}
          {str(d.npwz) ? <Row label="Numer prawa wykonywania zawodu">{str(d.npwz)} <Copy value={str(d.npwz)} /></Row> : null}
          {gz ? <Row label="Grupa zawodowa">{gz}</Row> : null}
          {specsText(d.sp).length ? <Row label="Specjalizacje">{specsText(d.sp).join('; ')}</Row> : null}
        </dl>
        {acts.length === 0 ? <p className="muted">Brak opisanych rodzajów działalności.</p> : null}
        <Capped items={acts} cap={20} render={(a, i) => <Activity key={i} a={a} rec={rec} />} />
      </section>
      {partners.length ? (
        <section><h3>Wspólnicy</h3>
          <Capped items={partners} cap={20} render={(w, i) => (
            <div key={i} className="partner">
              <strong>{str(w.n) || '(brak nazwy)'}</strong>
              <p className="muted">{[str(w.nip) ? `NIP ${str(w.nip)}` : '', str(w.gz), str(w.tyt), str(w.npwz) ? `npwz ${str(w.npwz)}` : '', specsText(w.sp).join('; ')].filter(Boolean).join(' · ')}</p>
              {arr(w.a).filter(isObj).map((a, j) => <Activity key={j} a={a} rec={rec} />)}
            </div>
          )} />
        </section>
      ) : null}
    </>
  );
}
