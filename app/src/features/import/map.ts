/**
 * Mapping a normalised index record to the contract's `ImportEntryRow` (CONTRACT.md 6.2) and the hashes of 6.3.
 */
import {
  HASH_VERSION, type DerivedFields, type FacetKey, type ImportEntryRow, type RegisterRec,
} from '../../lib/contract';
import type { Light } from '../validation/derive';
import { formTypeOf, wwwQuality } from '../validation/rules';
import { hash64Signed } from './sha256';
import type { PNorm, Prepared, RNorm } from './parse';

const CAP_FACET = 300;
const CAP_NAME = 1000;
/** the database refuses a `rec` above 1 MB; stay clearly below it */
export const REC_SOFT_LIMIT = 900_000;

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** h([1, email, emails, tel, phones, www]) */
export function contactHash(n: PNorm | RNorm): string {
  const emails = n.k === 'p' ? n.emails : [];
  return hash64Signed(JSON.stringify([HASH_VERSION, n.email, emails, n.tel, n.phones, n.www]));
}

/** Content hash of the normalised record (including `d` as the original string), 16 hex digits. */
export function contentHashInput(n: PNorm | RNorm): string {
  return JSON.stringify(n);
}

/** hAll = h([1, regKey, contentHash]); see CONTRACT.md Deviations (the content hash keeps one pass over the file enough). */
export function allHash(regKey: string, contentHashHex: string): string {
  return hash64Signed(JSON.stringify([HASH_VERSION, regKey, contentHashHex]));
}

/** h([1, derived fields in DerivedFields key order]) */
export function derivedHash(d: DerivedFields): string {
  return hash64Signed(JSON.stringify([HASH_VERSION, ...Object.values(d)]));
}

function one(v: string | null): string[] | undefined {
  return v === null ? undefined : [cap(v, CAP_FACET)];
}
function many(v: readonly string[]): string[] | undefined {
  return v.length === 0 ? undefined : v.map((x) => cap(x, CAP_FACET));
}

export function buildFacets(p: Prepared): Partial<Record<FacetKey, string[]>> {
  const out: Partial<Record<FacetKey, string[]>> = {};
  const put = (k: FacetKey, v: string[] | undefined) => {
    if (v) out[k] = v;
  };
  const n = p.norm;
  if (n.k === 'p') {
    put('p.status', one(n.status));
    put('p.rodzaje', many(n.rodzaje));
    put('p.grp', many(n.grp));
    put('p.spec', many(n.spec));
    put('p.dz', many(n.dz));
    put('p.fn', many(n.fn));
    put('p.forma', one(n.forma));
    put('p.formType', one(formTypeOf(n.forma)));
    put('p.woj', one(n.woj));
  } else {
    put('r.src', one(p.src));
    put('r.grupaPraktyk', one(n.grupaPraktyk));
    put('r.gz', many(n.gz));
    put('r.typ', one(n.typ));
    put('r.rodzaj', many(n.rodzaj));
    put('r.rd', many(n.rd));
    put('r.spec', many(n.spec));
    put('r.zakres', many(n.zakres));
    put('r.forma', one(n.forma));
    put('r.organ', one(n.organ));
    put('r.status', one(n.status));
    put('r.woj', one(n.woj));
  }
  return out;
}

/** Drops the largest parts of `d` until the stored record stays under the database limit. Returns the names dropped. */
export function shrinkDetail(d: Record<string, unknown>, rest: object): { d: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = [];
  let cur = d;
  const total = () => JSON.stringify(cur).length + JSON.stringify(rest).length;
  for (let i = 0; i < 6 && total() > REC_SOFT_LIMIT; i++) {
    let bestKey = '';
    let bestLen = 0;
    for (const k of Object.keys(cur)) {
      const len = JSON.stringify(cur[k]).length;
      if (len > bestLen) { bestLen = len; bestKey = k; }
    }
    if (bestKey === '' || bestKey === 'ks' || bestKey === 'org') break;
    cur = { ...cur, [bestKey]: Array.isArray(cur[bestKey]) ? [] : null };
    dropped.push(bestKey);
  }
  if (dropped.length) cur = { ...cur, trunc: dropped };
  return { d: cur, dropped };
}

export function buildRec(p: Prepared): { rec: RegisterRec; shrunk: boolean } {
  const n = p.norm;
  const base = n.k === 'p'
    ? { emails: n.emails, phones: n.phones, ulica: n.ulica, rodzaje: n.rodzaje, dz: n.dz, fn: n.fn }
    : { phones: n.phones, ulica: n.ulica, rodzaj: n.rodzaj, rd: n.rd };
  let d = p.d;
  let shrunk = false;
  if ((n.d?.length ?? 0) > REC_SOFT_LIMIT) {
    const s = shrinkDetail(d, base);
    d = s.d;
    shrunk = s.dropped.length > 0;
  }
  return { rec: { ...base, d } as RegisterRec, shrunk };
}

/** A practice has no e-mail field, but many typed one into WWW: it is used as the practice's e-mail (VAL-8). */
export function emailFromWww(n: PNorm | RNorm): string | null {
  if (n.k !== 'r' || n.email || !n.www) return null;
  return wwwQuality(n.www).email ?? null;
}

/** Everything the row needs beyond the record itself. */
export interface RowContext {
  keyHash: string;
  regKey: string;
  kseq: number;
  derived: DerivedFields;
  hAll: string;
  hContact: string;
  hDerived: string;
}

export function toEntryRow(p: Prepared, c: RowContext): { row: ImportEntryRow; shrunk: boolean } {
  const n = p.norm;
  const { rec, shrunk } = buildRec(p);
  const row: ImportEntryRow = {
    keyHash: c.keyHash,
    regKey: c.regKey,
    kind: n.k,
    src: p.src,
    org: p.org,
    ks: p.ks,
    kseq: c.kseq,
    name: n.name === null ? null : cap(n.name, CAP_NAME),
    nip: n.nip,
    email: n.email ?? emailFromWww(n),
    tel: n.tel,
    www: n.www,
    emails: n.k === 'p' ? n.emails : ((): string[] => { const m = emailFromWww(n); return m ? [m] : []; })(),
    miasto: n.miasto,
    kod: n.kod,
    wpis: n.wpis,
    stan: n.stan,
    nz: n.k === 'p' ? n.nz : null,
    nk: n.k === 'p' ? n.nk : null,
    facets: buildFacets(p),
    derived: c.derived,
    rec,
    hAll: c.hAll,
    hContact: c.hContact,
    hDerived: c.hDerived,
  };
  return { row, shrunk };
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** The fields the validation needs from a prepared record (keyHash and regDup are filled in after the whole file is read). */
export function lightOf(p: Prepared): Light {
  const n = p.norm;
  const partnerNips: string[] = [];
  const npwz: string[] = [];
  const partnerNpwz: string[] = [];
  if (n.k === 'p') {
    const sc = p.d.sc;
    if (Array.isArray(sc)) {
      for (const pair of sc) {
        const nip = Array.isArray(pair) ? pair[1] : null;
        if (typeof nip === 'string' && /^\d+$/.test(nip)) partnerNips.push(nip);
      }
    }
  } else {
    if (typeof p.d.npwz === 'string' && p.d.npwz.trim()) npwz.push(p.d.npwz.trim());
    const w = p.d.w;
    if (Array.isArray(w)) {
      for (const x of w) {
        if (!x || typeof x !== 'object') continue;
        const o = x as Record<string, unknown>;
        if (typeof o.nip === 'string' && /^\d+$/.test(o.nip)) partnerNips.push(o.nip);
        if (typeof o.npwz === 'string' && o.npwz.trim()) partnerNpwz.push(o.npwz.trim());
      }
    }
  }
  const wwwMail = n.k === 'r' ? emailFromWww(n) : null;
  return {
    kind: n.k,
    src: p.src,
    keyHash: '',
    regGroup: `${p.src}|${p.org}|${p.ks}`,
    regDup: false,
    name: n.name,
    nip: n.nip,
    forma: n.forma,
    typ: n.k === 'r' ? n.typ : null,
    status: n.status,
    stan: n.stan,
    woj: n.woj,
    email: n.email,
    emails: n.k === 'p' ? n.emails : n.email ? [n.email] : wwwMail ? [wwwMail] : [],
    emailFromWww: wwwMail !== null,
    tel: n.tel,
    phones: n.phones,
    www: n.www,
    partnerNips,
    npwz,
    partnerNpwz,
    spec: n.k === 'p' ? strList(n.spec) : [],
  };
}
