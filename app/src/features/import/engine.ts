/**
 * The import engine: everything the import does with the file, independent of Web Workers and of the network.
 * The worker (src/workers/import.worker.ts) wraps it with messages; the main thread talks to the database.
 *
 * Phases (CONTRACT.md 6.1):
 *   scan(file)      one streaming pass: normalise + hash every record, keep a light record per entry, then compute
 *                   book-number sequence numbers, accounts, derived fields, quality flags and proposals
 *   addState(text)  the database's `import_state` lines (in pages)
 *   plan()          classify every entry against the database: new / changed / returned / derived-only / unchanged / gone
 *   next*()         the batches to send; `nextEntries` re-reads the file (second pass) and builds full rows on demand,
 *                   so memory never holds more than the light records.
 */
import {
  HASH_VERSION, SOURCES, SOURCE_LABEL_PL, type DerivedFields, type DictEntry, type ImportBeginInput, type ImportCounts,
  type ImportEntryRow, type ImportProposalRow, type ImportDerivedRow, type Kind, type SourceId, type ValDecisions,
} from '../../lib/contract';
import { deriveAll, type Light } from '../validation/derive';
import {
  ImportError, MSG_FORMAT_CHANGED, MSG_RESAVE, iterateIndex, openIndex, prepareRecord, type BlobLike, type IndexHeader, type Prepared,
} from './parse';
import { allHash, contactHash, contentHashInput, derivedHash, lightOf, toEntryRow } from './map';
import { Sha256, hash64Hex, toHex } from './sha256';

export type Phase = 'reading' | 'validation' | 'comparing' | 'sending';
export type ProgressFn = (phase: Phase, done: number, total: number) => void;

/** Light record plus the hashes of the entry. */
export interface EngineRec extends Light {
  wpis: string | null;
  kseq: number;
  /** 16 hex digits: SHA-256 of the normalised record */
  ch: string;
  hContact: string;
  hAll: string;
  hDerived: string;
}

export interface StateRow { id: number; hAll: string; hContact: string; hDerived: string; inRegister: boolean; src: number }

export const SEND = { NONE: 0, NEW: 1, CHANGED: 2, RETURNED: 3, DERIVED: 4 } as const;

export interface ScanResult {
  header: IndexHeader;
  fileSha256: string;
  reportDate: string;
  /** valid records */
  records: number;
  rejected: number;
  rejectedReasons: Record<string, number>;
  /** records whose detail was too large for one database row and was reduced */
  reducedDetail: number;
  bySource: Record<string, number>;
  proposalCounts: Record<string, number>;
  autoGenericDomains: string[];
}

export interface PlanResult {
  total: ImportCounts;
  byKind: Record<Kind, ImportCounts>;
  /** per fully contained source: how many entries the database has in the register and how many of them are gone */
  goneBySource: Array<{ src: SourceId; inRegister: number; gone: number; share: number }>;
  sourcesOver10PercentGone: SourceId[];
  /** ids and key hashes of entries whose register data change and that may carry CRM work (checked through the database) */
  candidates: Array<{ id: number; keyHash: string; change: 'gone' | 'contact' }>;
}

const emptyCounts = (): ImportCounts => ({ total: 0, new: 0, changed: 0, changedContact: 0, returned: 0, gone: 0, unchanged: 0, derivedOnly: 0, rejected: 0 });

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class ImportEngine {
  private decisions: ValDecisions | null = null;
  private header: IndexHeader | null = null;
  private recs: EngineRec[] = [];
  private derived: DerivedFields[] = [];
  private proposals: ImportProposalRow[] = [];
  private rejectedOrd = new Set<number>();
  private state = new Map<string, StateRow & { seen: boolean }>();
  private send = new Uint8Array(0);
  private goneHashes: string[] = [];
  private derivedIdx: number[] = [];
  private seenFacets = new Map<string, Set<string>>();
  private blob: BlobLike | null = null;
  private entryIter: AsyncGenerator<ImportEntryRow> | null = null;
  private propPos = 0;
  private derivedPos = 0;
  private gonePos = 0;
  private scanResult: ScanResult | null = null;
  private planResult: PlanResult | null = null;

  setDecisions(d: ValDecisions | null): void {
    this.decisions = d;
  }

  /* ------------------------------------------------------------------------------------------------------------
   * Pass 1
   * -------------------------------------------------------------------------------------------------------- */
  async scan(blob: BlobLike, onProgress?: ProgressFn): Promise<ScanResult> {
    this.reset();
    this.blob = blob;
    const sha = new Sha256();
    let bytes = 0;
    const stream = await openIndex(blob, { onChunk: (c) => { sha.update(c); bytes += c.length; } });
    const recs: EngineRec[] = [];
    const groups = new Map<string, number | number[]>();
    const rejectedReasons: Record<string, number> = {};
    const perSource = new Map<string, { n: number; weak: number; contact: number }>();
    let ordinal = 0;
    let reduced = 0;
    let header: IndexHeader | null = null;
    const seen = this.seenFacets;
    const mark = (facet: string, v: string | null | undefined) => {
      if (!v) return;
      let s = seen.get(facet);
      if (!s) seen.set(facet, (s = new Set()));
      s.add(v);
    };

    for await (const item of iterateIndex(stream)) {
      if (item.type === 'header') {
        header = item.header;
        continue;
      }
      const ord = ordinal++;
      let raw: unknown;
      let prep: Prepared | string;
      try {
        raw = JSON.parse(item.line);
        prep = prepareRecord(item.kind, raw);
      } catch {
        prep = 'json does not parse';
      }
      if (typeof prep === 'string') {
        this.rejectedOrd.add(ord);
        rejectedReasons[prep] = (rejectedReasons[prep] ?? 0) + 1;
        continue;
      }
      const n = prep.norm;
      const l = lightOf(prep);
      const idx = recs.length;
      const rec: EngineRec = Object.assign(l, {
        wpis: n.wpis,
        kseq: 1,
        ch: hash64Hex(contentHashInput(n)),
        hContact: contactHash(n),
        hAll: '',
        hDerived: '',
      });
      recs.push(rec);
      if (((n.d?.length ?? 0) > 900_000)) reduced++;
      const g = groups.get(rec.regGroup);
      if (g === undefined) groups.set(rec.regGroup, idx);
      else if (typeof g === 'number') groups.set(rec.regGroup, [g, idx]);
      else g.push(idx);

      let ps = perSource.get(prep.src);
      if (!ps) perSource.set(prep.src, (ps = { n: 0, weak: 0, contact: 0 }));
      ps.n++;
      if (!n.name || !n.nip) ps.weak++;
      if (n.email || n.tel || (n.k === 'p' && n.emails.length) || n.phones.length) ps.contact++;

      if (n.k === 'p') {
        mark('p.status', n.status); mark('p.woj', n.woj);
        for (const s of n.spec) mark('p.spec', s);
        for (const s of n.fn) mark('p.fn', s);
        for (const s of n.grp) mark('p.grp', s);
      } else {
        mark('r.src', prep.src); mark('r.status', n.status); mark('r.woj', n.woj);
      }
      if (ord % 2000 === 0) {
        onProgress?.('reading', Math.min(bytes, blob.size), blob.size);
        await Promise.resolve();
      }
    }
    if (!header) throw new ImportError(`Plik indeksu jest pusty. ${MSG_RESAVE}`);
    onProgress?.('reading', blob.size, blob.size);
    if (recs.length === 0) throw new ImportError('Indeks nie zawiera żadnych rekordów. Sprawdź w narzędziu RPWDL, czy rejestry zostały wczytane, zapisz indeks ponownie (przycisk „Zapisz indeks do pliku”) i wybierz nowy plik.');

    // format-change guard (SPEC 4.10)
    for (const [, s] of perSource) {
      if (s.n >= 20 && s.weak / s.n > 0.5) throw new ImportError(MSG_FORMAT_CHANGED);
      if (s.n >= 50 && s.contact === 0) throw new ImportError(MSG_FORMAT_CHANGED);
    }

    onProgress?.('validation', 0, 3);
    // book-number sequence: entries sharing (src, org, ks) are ordered by (wpis null last, name, nip, file order)
    for (const members of groups.values()) {
      if (typeof members === 'number') continue;
      const sorted = [...members].sort((a, b) => {
        const x = recs[a] as EngineRec, y = recs[b] as EngineRec;
        if ((x.wpis === null) !== (y.wpis === null)) return x.wpis === null ? 1 : -1;
        return cmp(x.wpis ?? '', y.wpis ?? '') || cmp(x.name ?? '', y.name ?? '') || cmp(x.nip ?? '', y.nip ?? '') || a - b;
      });
      sorted.forEach((i, pos) => {
        const r = recs[i] as EngineRec;
        r.kseq = pos + 1;
        r.regDup = true;
      });
    }
    for (const r of recs) {
      const regKey = `${r.regGroup}|${r.kseq}`;
      r.keyHash = hash64Hex(regKey);
      r.hAll = allHash(regKey, r.ch);
    }

    onProgress?.('validation', 1, 3);
    const res = deriveAll(recs, this.decisions);
    onProgress?.('validation', 2, 3);
    for (let i = 0; i < recs.length; i++) (recs[i] as EngineRec).hDerived = derivedHash(res.derived[i] as DerivedFields);
    onProgress?.('validation', 3, 3);

    this.recs = recs;
    this.derived = res.derived;
    this.proposals = res.proposals;
    this.header = header;
    const proposalCounts: Record<string, number> = {};
    // Only proposals that will be open after the import: one the DB holds as decided stays decided unless it gained members
    // (api.import_proposals reopens it then), so those are left out (RD3-2).
    const decided = new Map<string, Set<string>>();
    for (const d of this.decisions?.decidedProposals ?? []) decided.set(`${d.kind}\u0000${d.matchValue}`, new Set(d.members));
    for (const p of res.proposals) {
      const seen = decided.get(`${p.kind}\u0000${p.matchValue.length > 500 ? Array.from(p.matchValue).slice(0, 500).join('') : p.matchValue}`);
      if (seen && p.members.every((m) => seen.has(m))) continue;
      proposalCounts[p.kind] = (proposalCounts[p.kind] ?? 0) + 1;
    }
    const bySource: Record<string, number> = {};
    for (const [id, s] of perSource) bySource[id] = s.n;
    const dated = header.sources.filter((s) => s.records > 0 && s.reportDate).map((s) => s.reportDate as string).sort();
    const reportDate = dated[0] ?? header.today ?? '';
    if (!reportDate) throw new ImportError(`W pliku brakuje daty raportu rejestru. ${MSG_RESAVE}`);
    this.scanResult = {
      header,
      fileSha256: toHex(sha.digest()),
      reportDate,
      records: recs.length,
      rejected: ordinal - recs.length,
      rejectedReasons,
      reducedDetail: reduced,
      bySource,
      proposalCounts,
      autoGenericDomains: res.autoGenericDomains,
    };
    return this.scanResult;
  }

  private reset(): void {
    this.header = null;
    this.recs = [];
    this.derived = [];
    this.proposals = [];
    this.rejectedOrd = new Set();
    this.seenFacets = new Map();
    this.send = new Uint8Array(0);
    this.goneHashes = [];
    this.derivedIdx = [];
    this.entryIter = null;
    this.propPos = this.derivedPos = this.gonePos = 0;
    this.scanResult = null;
    this.planResult = null;
  }

  /* ------------------------------------------------------------------------------------------------------------
   * Comparing with the database
   * -------------------------------------------------------------------------------------------------------- */
  /** Adds lines of `import_state().data` (tab separated: id, keyHash, hAll, hContact, hDerived, inRegister, src). */
  addState(text: string): number {
    let n = 0;
    if (text === '') return 0;
    for (const line of text.split('\n')) {
      const f = line.split('\t');
      if (f.length < 7) continue;
      this.state.set(f[1] as string, {
        id: Number(f[0]), hAll: f[2] as string, hContact: f[3] as string, hDerived: f[4] as string,
        inRegister: f[5] === '1', src: Number(f[6]), seen: false,
      });
      n++;
    }
    return n;
  }

  stateSize(): number {
    return this.state.size;
  }

  plan(): PlanResult {
    if (!this.scanResult || !this.header) throw new Error('scan first');
    const total = emptyCounts();
    const byKind: Record<Kind, ImportCounts> = { p: emptyCounts(), r: emptyCounts() };
    const send = new Uint8Array(this.recs.length);
    const candidates: PlanResult['candidates'] = [];
    const derivedIdx: number[] = [];
    for (let i = 0; i < this.recs.length; i++) {
      const r = this.recs[i] as EngineRec;
      const c = byKind[r.kind];
      c.total++;
      const s = this.state.get(r.keyHash);
      if (!s) { c.new++; send[i] = SEND.NEW; continue; }
      s.seen = true;
      if (!s.inRegister) { c.returned++; send[i] = SEND.RETURNED; continue; }
      if (s.hAll !== r.hAll) {
        c.changed++;
        send[i] = SEND.CHANGED;
        if (s.hContact !== r.hContact) {
          c.changedContact++;
          candidates.push({ id: s.id, keyHash: r.keyHash, change: 'contact' });
        }
        continue;
      }
      if (s.hDerived !== r.hDerived) { c.derivedOnly++; send[i] = SEND.DERIVED; derivedIdx.push(i); continue; }
      c.unchanged++;
    }
    // gone: entries of sources that are fully contained in the file but missing from it
    const full = new Set<number>();
    for (const s of this.header.sources) if (s.records > 0) full.add((SOURCES as readonly string[]).indexOf(s.id));
    const perSrcIn = new Map<number, number>();
    const perSrcGone = new Map<number, number>();
    const gone: string[] = [];
    for (const [hash, s] of this.state) {
      if (!s.inRegister || !full.has(s.src)) continue;
      perSrcIn.set(s.src, (perSrcIn.get(s.src) ?? 0) + 1);
      if (!s.seen) {
        gone.push(hash);
        perSrcGone.set(s.src, (perSrcGone.get(s.src) ?? 0) + 1);
        candidates.push({ id: s.id, keyHash: hash, change: 'gone' });
        byKind[s.src === 0 ? 'p' : 'r'].gone++;
      }
    }
    for (const k of ['p', 'r'] as const) {
      const c = byKind[k];
      total.total += c.total; total.new += c.new; total.changed += c.changed; total.changedContact += c.changedContact;
      total.returned += c.returned; total.gone += c.gone; total.unchanged += c.unchanged; total.derivedOnly += c.derivedOnly;
    }
    total.rejected = this.scanResult.rejected;
    const goneBySource = [...perSrcIn].map(([src, inReg]) => {
      const g = perSrcGone.get(src) ?? 0;
      return { src: SOURCES[src] as SourceId, inRegister: inReg, gone: g, share: inReg > 0 ? g / inReg : 0 };
    });
    this.send = send;
    this.goneHashes = gone;
    this.derivedIdx = derivedIdx;
    this.entryIter = null;
    this.derivedPos = this.gonePos = this.propPos = 0;
    this.planResult = {
      total,
      byKind,
      goneBySource,
      sourcesOver10PercentGone: goneBySource.filter((g) => g.share > 0.1).map((g) => g.src),
      candidates,
    };
    return this.planResult;
  }

  /** `import_begin` payload for the current scan and plan. */
  beginInput(fileName: string): ImportBeginInput {
    if (!this.scanResult || !this.planResult || !this.header) throw new Error('scan and plan first');
    const h = this.header;
    return {
      fileName,
      fileSha256: this.scanResult.fileSha256,
      indexVersion: 2,
      createdAt: h.createdAt,
      today: h.today ?? this.scanResult.reportDate,
      reportDate: this.scanResult.reportDate,
      sources: h.sources.map((s) => ({ id: s.id, records: s.records, reportDate: s.reportDate, today: s.today, bad: s.bad })),
      hashVersion: HASH_VERSION,
      preview: this.planResult.total,
    };
  }

  /* ------------------------------------------------------------------------------------------------------------
   * Labels
   * -------------------------------------------------------------------------------------------------------- */
  labels(): DictEntry[] {
    const out: DictEntry[] = [];
    const h = this.header;
    if (!h) return out;
    const set = (facet: string) => [...(this.seenFacets.get(facet) ?? [])].sort();
    for (const code of set('p.spec')) {
      const name = h.names.spec[code];
      out.push({ facet: 'p.spec', val: code, label: code === '?' ? '? — Brak lub nieprawidłowy kod' : name ? `${code} — ${name}` : null });
    }
    for (const code of set('p.fn')) {
      const name = h.names.fn[code];
      if (name) out.push({ facet: 'p.fn', val: code, label: name });
    }
    for (const g of set('p.grp')) {
      out.push({ facet: 'p.grp', val: g, label: g === '?' ? '? — Nieprzypisane / nieprawidłowy kod' : GROUP_NAMES[g] ? `${g} — ${GROUP_NAMES[g]}` : null });
    }
    for (const s of set('p.status')) out.push({ facet: 'p.status', val: s, label: P_STATUS_LABEL[s] ?? null });
    for (const [v, l] of Object.entries(FORMTYPE_LABEL)) out.push({ facet: 'p.formType', val: v, label: l });
    for (const w of set('p.woj')) out.push({ facet: 'p.woj', val: w, label: capFirst(w) });
    for (const w of set('r.woj')) out.push({ facet: 'r.woj', val: w, label: capFirst(w) });
    for (const s of set('r.src')) out.push({ facet: 'r.src', val: s, label: SOURCE_LABEL_PL[s as SourceId] ?? null });
    for (const s of set('r.status')) out.push({ facet: 'r.status', val: s, label: R_STATUS_LABEL[s] ?? null });
    return out.filter((e) => e.label !== null);
  }

  /* ------------------------------------------------------------------------------------------------------------
   * Batches
   * -------------------------------------------------------------------------------------------------------- */
  /** Next rows for `import_entries` (new, changed, returned), at most `maxRows` and about `maxBytes` of text. Empty = done. */
  async nextEntries(maxRows: number, maxBytes = 4_000_000): Promise<ImportEntryRow[]> {
    if (!this.planResult || !this.blob) throw new Error('plan first');
    if (!this.entryIter) this.entryIter = this.entryRows();
    const rows: ImportEntryRow[] = [];
    let bytes = 0;
    while (rows.length < maxRows && (rows.length === 0 || bytes < maxBytes)) {
      const { value, done } = await this.entryIter.next();
      if (done) break;
      rows.push(value);
      bytes += (value.rec.d ? JSON.stringify(value.rec.d).length : 0) + 800;
    }
    return rows;
  }

  /** Number of entries nextEntries will deliver in total. */
  entriesToSend(): number {
    const t = this.planResult?.total;
    return t ? t.new + t.changed + t.returned : 0;
  }

  private async *entryRows(): AsyncGenerator<ImportEntryRow> {
    const blob = this.blob as BlobLike;
    const stream = await openIndex(blob);
    let ordinal = 0;
    let idx = 0;
    for await (const item of iterateIndex(stream)) {
      if (item.type !== 'record') continue;
      const ord = ordinal++;
      if (this.rejectedOrd.has(ord)) continue;
      const i = idx++;
      const code = this.send[i];
      if (code !== SEND.NEW && code !== SEND.CHANGED && code !== SEND.RETURNED) continue;
      const prep = prepareRecord(item.kind, JSON.parse(item.line));
      const rec = this.recs[i] as EngineRec | undefined;
      if (typeof prep === 'string' || !rec || rec.regGroup !== `${prep.src}|${prep.org}|${prep.ks}`) {
        throw new ImportError('Plik zmienił się w trakcie importu. Wybierz go ponownie i zacznij od początku.');
      }
      yield toEntryRow(prep, {
        keyHash: rec.keyHash,
        regKey: `${rec.regGroup}|${rec.kseq}`,
        kseq: rec.kseq,
        derived: this.derived[i] as DerivedFields,
        hAll: rec.hAll,
        hContact: rec.hContact,
        hDerived: rec.hDerived,
      }).row;
    }
  }

  nextDerived(max: number): ImportDerivedRow[] {
    const out: ImportDerivedRow[] = [];
    while (out.length < max && this.derivedPos < this.derivedIdx.length) {
      const i = this.derivedIdx[this.derivedPos++] as number;
      const r = this.recs[i] as EngineRec;
      out.push({ keyHash: r.keyHash, derived: this.derived[i] as DerivedFields, hDerived: r.hDerived });
    }
    return out;
  }

  nextGone(max: number): string[] {
    const out = this.goneHashes.slice(this.gonePos, this.gonePos + max);
    this.gonePos += out.length;
    return out;
  }

  /** Next proposals; `last` is true for the final chunk (the caller then sends `p_final = true`). */
  nextProposals(max: number): { rows: ImportProposalRow[]; last: boolean } {
    const rows = this.proposals.slice(this.propPos, this.propPos + max);
    this.propPos += rows.length;
    return { rows, last: this.propPos >= this.proposals.length };
  }

  counts(): { derived: number; gone: number; proposals: number; entries: number } {
    return { derived: this.derivedIdx.length, gone: this.goneHashes.length, proposals: this.proposals.length, entries: this.entriesToSend() };
  }

  /** For tests and the local acceptance run (never sent anywhere). */
  debug(): { recs: readonly EngineRec[]; derived: readonly DerivedFields[]; proposals: readonly ImportProposalRow[] } {
    return { recs: this.recs, derived: this.derived, proposals: this.proposals };
  }
}

const capFirst = (s: string) => s.charAt(0).toLocaleUpperCase('pl') + s.slice(1);
const GROUP_NAMES: Record<string, string> = {
  '0': 'Podstawowa opieka zdrowotna',
  '1': 'Poradnie specjalistyczne',
  '2': 'Ośrodki (zespoły) opieki pozaszpitalnej',
  '3': 'Pomoc doraźna i ratownictwo medyczne',
  '4': 'Oddziały szpitalne i inne komórki opieki szpitalnej',
  '5': 'Zakłady opiekuńczo-lecznicze i pielęgnacyjno-opiekuńcze',
  '6': 'Jednostki lecznictwa uzdrowiskowego',
  '7': 'Pracownie diagnostyczne lub zabiegowe',
  '8': 'Pracownie protetyczne, przedmiotów ortopedycznych, środków pomocniczych, krwi i tkanek',
  '9': 'Inne komórki organizacyjne działalności medycznej',
};
const P_STATUS_LABEL: Record<string, string> = { aktywny: 'Aktywny', nierozpoczety: 'Nierozpoczęty', zakonczony: 'Zakończony' };
const R_STATUS_LABEL: Record<string, string> = { active: 'Aktywny', suspended: 'Zawieszony', inactive: 'Nieaktywny', '?': 'Nieznany status' };
const FORMTYPE_LABEL: Record<string, string> = {
  komercyjna: 'Komercyjna (prywatna)',
  publiczna: 'Publiczna',
  inna: 'Inna (fundacje, kościoły, organizacje bez celu zysku, pozostałe)',
};
