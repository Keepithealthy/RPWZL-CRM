/**
 * Reading an `rpwdl-lead-index` file (offline tool SPEC section 6 and V2.6) and normalising its records.
 *
 * The file is line oriented: a header line ending with `"records":{`, then `"p":[`, one record per line, `],`,
 * `"r":[`, one record per line, `]`, `}}`. It is read as a stream (optionally gunzipped with DecompressionStream),
 * never as one string, so a 440 MB index never has to fit in memory twice.
 */
import { SOURCES, type Kind, type SourceId } from '../../lib/contract';

export class ImportError extends Error {
  /** Polish, shown to the owner as is */
  messagePl: string;
  constructor(messagePl: string) {
    super(messagePl);
    this.name = 'ImportError';
    this.messagePl = messagePl;
  }
}

export const INDEX_FORMAT = 'rpwdl-lead-index';
export const MAX_D_CHARS = 4_000_000;
const MAX_LINE_CHARS = 8_000_000;
const MAX_ARR = 5000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MSG_V1 =
  'Ten plik indeksu jest w wersji 1 — zapisz indeks ponownie nowszą wersją narzędzia (v2). Wersja 1 nie zawiera numeru księgi rejestrowej ani szczegółów wpisu, więc CRM nie potrafi rozpoznać wpisów przy kolejnych odświeżeniach.';
/** What to do next after a file error (UX-R4-2): every message that only diagnoses ends with it. */
export const MSG_RESAVE = 'Zapisz indeks ponownie w narzędziu RPWDL (przycisk „Zapisz indeks do pliku”) i wybierz nowy plik. Jeśli błąd się powtarza, przekaż ten komunikat administratorowi CRM.';
export const MSG_NOT_INDEX = 'To nie jest plik indeksu zapisany przez narzędzie RPWDL. Zapisz indeks w narzędziu RPWDL (przycisk „Zapisz indeks do pliku”) i wybierz ten plik.';
/** A stream or decompression error (truncated or corrupt gzip, interrupted copy): the file itself is damaged (UX-R5-1). */
export const MSG_CORRUPT = `Plik jest niekompletny albo uszkodzony (np. przerwane pobieranie). ${MSG_RESAVE}`;
export const MSG_LAYOUT = `Układ pliku jest nieznany — wygląda na uszkodzony albo zapisany inną wersją narzędzia. ${MSG_RESAVE}`;
export const MSG_FORMAT_CHANGED = `Format pliku wygląda na zmieniony — dane nie zostały wczytane. ${MSG_RESAVE}`;
export const msgVersion = (v: unknown): string => (typeof v === 'number' && v > 2
  ? `Ten plik zapisała nowsza wersja narzędzia RPWDL (wersja indeksu ${v}) — CRM trzeba zaktualizować. Przekaż ten komunikat administratorowi CRM.`
  : `Nieobsługiwana wersja indeksu (${String(v)}). ${MSG_RESAVE}`);

export interface SourceMeta {
  id: SourceId;
  label: string;
  records: number;
  reportDate: string | null;
  file: string | null;
  kind: Kind;
  today: string | null;
  bad: number;
}
export interface IndexHeader {
  format: string;
  version: number;
  today: string | null;
  createdAt: string | null;
  sources: SourceMeta[];
  names: { spec: Record<string, string>; fn: Record<string, string> };
}

/* ---------- normalised record (same whitelist and key order as the tool's fixIndexRecord) ---------- */
export interface PNorm {
  k: 'p'; src: string | null; name: string | null; nip: string | null; email: string | null; www: string | null; tel: string | null;
  emails: string[]; phones: string[]; forma: string | null; woj: string | null; miasto: string | null; ulica: string | null;
  kod: string | null; status: string; stan: string | null; rodzaje: string[]; grp: string[]; spec: string[]; dz: string[]; fn: string[];
  nz: number; nk: number; wpis: string | null; d: string | null;
}
export interface RNorm {
  k: 'r'; src: string | null; name: string | null; nip: string | null; email: string | null; www: string | null; tel: string | null;
  phones: string[]; grupaPraktyk: string | null; typ: string | null; forma: string | null; organ: string | null; status: string;
  woj: string | null; miasto: string | null; ulica: string | null; kod: string | null; stan: string | null; gz: string[];
  rodzaj: string[]; rd: string[]; spec: string[]; zakres: string[]; wpis: string | null; d: string | null;
}
export type Norm = PNorm | RNorm;

const interned = new Map<string, string>();
function intern(v: string): string {
  const hit = interned.get(v);
  if (hit !== undefined) return hit;
  if (interned.size < 50_000) interned.set(v, v);
  return v;
}
function str(v: unknown, doIntern = false): string | null {
  return typeof v === 'string' && v !== '' ? (doIntern ? intern(v) : v) : null;
}
function arr(v: unknown, doIntern = false): string[] {
  const out: string[] = [];
  if (!Array.isArray(v)) return out;
  for (let i = 0; i < v.length && out.length < MAX_ARR; i++) {
    const x = str(v[i], doIntern);
    if (x !== null) out.push(x);
  }
  return out;
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function dateOrNull(v: unknown): string | null {
  return typeof v === 'string' && DATE_RE.test(v) ? v : null;
}

/** Rebuilds a record from whitelisted keys with the expected types (an index file is untrusted input). */
export function fixIndexRecord(r: unknown, kind: Kind): Norm | null {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const o = r as Record<string, unknown>;
  const wpis = dateOrNull(o.wpis);
  const d = typeof o.d === 'string' && o.d.length <= MAX_D_CHARS ? o.d : null;
  let nip: string | null = typeof o.nip === 'string' ? o.nip.replace(/\D+/g, '') : '';
  nip = nip === '' ? null : nip;
  const stan = dateOrNull(o.stan);
  const status = str(o.status, true) ?? (kind === 'p' ? 'aktywny' : '?');
  if (kind === 'p') {
    return {
      k: 'p', src: str(o.src, true), name: str(o.name), nip, email: str(o.email), www: str(o.www), tel: str(o.tel),
      emails: arr(o.emails), phones: arr(o.phones), forma: str(o.forma, true), woj: str(o.woj, true), miasto: str(o.miasto, true),
      ulica: str(o.ulica), kod: str(o.kod, true), status, stan, rodzaje: arr(o.rodzaje, true), grp: arr(o.grp, true),
      spec: arr(o.spec, true), dz: arr(o.dz, true), fn: arr(o.fn, true), nz: num(o.nz), nk: num(o.nk), wpis, d,
    };
  }
  return {
    k: 'r', src: str(o.src, true), name: str(o.name), nip, email: str(o.email), www: str(o.www), tel: str(o.tel), phones: arr(o.phones),
    grupaPraktyk: str(o.grupaPraktyk, true), typ: str(o.typ, true), forma: str(o.forma, true), organ: str(o.organ, true), status,
    woj: str(o.woj, true), miasto: str(o.miasto, true), ulica: str(o.ulica), kod: str(o.kod, true), stan, gz: arr(o.gz, true),
    rodzaj: arr(o.rodzaj, true), rd: arr(o.rd, true), spec: arr(o.spec, true), zakres: arr(o.zakres, true), wpis, d,
  };
}

/* ---------- a record ready for hashing / mapping ---------- */
export interface Prepared {
  norm: Norm;
  /** parsed compact detail */
  d: Record<string, unknown>;
  src: SourceId;
  org: string;
  ks: string;
}

/** Normalises one parsed record line. Returns a reason string when the record must be rejected. */
export function prepareRecord(kind: Kind, raw: unknown): Prepared | string {
  const norm = fixIndexRecord(raw, kind);
  if (!norm) return 'not an object';
  const src = kind === 'p' ? 'Rpm' : norm.src;
  if (!src || !(SOURCES as readonly string[]).includes(src)) return 'unknown source';
  if (kind === 'r' && src === 'Rpm') return 'practice with source Rpm';
  if (norm.d === null) return 'detail missing or too long';
  let d: unknown;
  try {
    d = JSON.parse(norm.d);
  } catch {
    return 'detail does not parse';
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'detail is not an object';
  const dd = d as Record<string, unknown>;
  const ks = typeof dd.ks === 'string' ? dd.ks.trim() : '';
  if (ks === '') return 'book number missing';
  const org = kind === 'p' ? (typeof dd.org === 'string' ? dd.org : '') : (norm as RNorm).organ ?? '';
  return { norm, d: dd, src: src as SourceId, org, ks };
}

/* ---------- stream reading ---------- */
export interface BlobLike {
  size: number;
  name?: string;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
  stream(): ReadableStream<Uint8Array>;
}

export async function isGzip(blob: BlobLike): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}

export interface OpenOptions {
  /** called for every chunk of the raw (compressed) file, in order */
  onChunk?: (chunk: Uint8Array) => void;
}

/** The decompressed byte stream of an index file. */
export async function openIndex(blob: BlobLike, opts: OpenOptions = {}): Promise<ReadableStream<Uint8Array>> {
  const gz = await isGzip(blob);
  let s = blob.stream();
  if (opts.onChunk) {
    const cb = opts.onChunk;
    s = s.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctl) { cb(chunk); ctl.enqueue(chunk); } }));
  }
  if (gz) {
    if (typeof DecompressionStream === 'undefined') {
      throw new ImportError('Ta przeglądarka nie obsługuje dekompresji — użyj aktualnej wersji Google Chrome.');
    }
    s = s.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
  }
  return s;
}

export type IndexItem =
  | { type: 'header'; header: IndexHeader }
  | { type: 'record'; kind: Kind; line: string };

async function* textLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder('utf-8');
  let tail = '';
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw e instanceof ImportError ? e : new ImportError(MSG_CORRUPT);
      }
      const { done, value } = chunk;
      if (done) break;
      tail += dec.decode(value, { stream: true });
      let s = 0;
      for (;;) {
        const k = tail.indexOf('\n', s);
        if (k < 0) break;
        yield k > s && tail.charCodeAt(k - 1) === 13 ? tail.slice(s, k - 1) : tail.slice(s, k);
        s = k + 1;
      }
      tail = s > 0 ? tail.slice(s) : tail;
      if (tail.length > MAX_LINE_CHARS) throw new ImportError(`Plik indeksu zawiera nienormalnie długi wiersz — wygląda na uszkodzony. ${MSG_RESAVE}`);
    }
    tail += dec.decode();
    if (tail !== '') yield tail;
  } finally {
    reader.releaseLock();
  }
}

export function parseHeader(line: string): IndexHeader {
  let obj: unknown;
  try {
    obj = JSON.parse(line + '}}');
  } catch {
    throw new ImportError(MSG_LAYOUT);
  }
  const h = obj as Record<string, unknown>;
  if (!h || h.format !== INDEX_FORMAT) throw new ImportError(MSG_NOT_INDEX);
  if (h.version === 1) throw new ImportError(MSG_V1);
  if (h.version !== 2) throw new ImportError(msgVersion(h.version));
  const sources: SourceMeta[] = [];
  for (const s of Array.isArray(h.sources) ? (h.sources as Array<Record<string, unknown>>) : []) {
    const id = s?.id;
    if (typeof id !== 'string' || !(SOURCES as readonly string[]).includes(id)) continue;
    sources.push({
      id: id as SourceId,
      label: typeof s.label === 'string' ? s.label : id,
      records: typeof s.records === 'number' ? s.records : 0,
      reportDate: dateOrNull(s.reportDate),
      file: typeof s.file === 'string' ? s.file.slice(0, 200) : null,
      kind: id === 'Rpm' ? 'p' : 'r',
      today: dateOrNull(s.today),
      bad: typeof s.bad === 'number' ? s.bad : 0,
    });
  }
  const names = (h.names ?? {}) as { spec?: Record<string, unknown>; fn?: Record<string, unknown> };
  const pick = (m: Record<string, unknown> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    if (m && typeof m === 'object') for (const k of Object.keys(m)) if (typeof m[k] === 'string') out[k] = (m[k] as string).slice(0, 300);
    return out;
  };
  return {
    format: INDEX_FORMAT,
    version: 2,
    today: dateOrNull(h.today),
    createdAt: typeof h.createdAt === 'string' ? h.createdAt : null,
    sources,
    names: { spec: pick(names.spec), fn: pick(names.fn) },
  };
}

/** Walks the line layout and yields the header first, then one item per record line. */
export async function* iterateIndex(stream: ReadableStream<Uint8Array>): AsyncGenerator<IndexItem> {
  let first = true;
  let cur: Kind | null = null;
  for await (let line of textLines(stream)) {
    if (first) {
      first = false;
      // a file that never names the index format (plain text, another JSON) is not an index at all (UX-R4-2)
      if (!/"records":\{\s*$/.test(line)) throw new ImportError(line.includes(`"${INDEX_FORMAT}"`) ? MSG_LAYOUT : MSG_NOT_INDEX);
      yield { type: 'header', header: parseHeader(line.trimEnd()) };
      continue;
    }
    if (line === '"p":[') { cur = 'p'; continue; }
    if (line === '"r":[') { cur = 'r'; continue; }
    const c = line.charCodeAt(0);
    if (c === 93 /* ] */ || c === 125 /* } */) { cur = null; continue; }
    if (cur === null || line.trim() === '') continue;
    if (line.charCodeAt(line.length - 1) === 44) line = line.slice(0, -1);
    yield { type: 'record', kind: cur, line };
  }
  if (first) throw new ImportError(MSG_NOT_INDEX);
}
