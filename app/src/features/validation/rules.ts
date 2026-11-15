/**
 * Validation rules ("kto jest kim"), SPEC.md section 6. Pure functions, no I/O.
 *
 * Shared by the import worker (which stores the results in `DerivedFields`) and by the UI (the record card labels
 * contacts with them; it never reimplements them). Phone logic is a port of the offline RPWDL tool V2.1.2-V2.1.8,
 * so numbers stay comparable with it.
 */
import { ENTITY_TYPE, NIP_STATUS, QFLAG, type EntityType, type NipStatus } from '../../lib/contract';

/* ------------------------------------------------------------------------------------------------------------------
 * Phones (national numbering plan, Dz.U. 2024 poz. 1862)
 * ---------------------------------------------------------------------------------------------------------------- */
export type PhoneClass = 'kom' | 'stac' | 'inny' | 'zly';
export interface ParsedPhone { n: string; cls: Exclude<PhoneClass, 'zly'> }

const PHONE_CLS: PhoneClass[] = (() => {
  const t: PhoneClass[] = new Array<PhoneClass>(100).fill('zly');
  const set = (list: Array<number | [number, number]>, cls: PhoneClass) => {
    for (const x of list) {
      if (typeof x === 'number') t[x] = cls;
      else for (let k = x[0]; k <= x[1]; k++) t[k] = cls;
    }
  };
  set([45, 50, 51, 53, 57, 60, 66, 69, 72, 73, 78, 79, 88], 'kom');
  set([[12, 18], [22, 25], 29, [32, 34], [41, 44], 46, 48, 52, [54, 56], 58, 59, [61, 63], 65, 67, 68, 71, [74, 77], [81, 87], 89, 91, 94, 95], 'stac');
  set([20, 21, 26, 27, 28, 39, 47, 64, 70, 80], 'inny');
  return t;
})();

/** Class of a 9-digit national number by its first two digits ('zly' = not dialable). */
export function phoneClass(n: string): PhoneClass {
  if (typeof n !== 'string' || n.length !== 9 || n.charCodeAt(0) === 48 || !/^\d{9}$/.test(n)) return 'zly';
  return PHONE_CLS[Number(n.slice(0, 2))] ?? 'zly';
}

const PH_SPACE_RE = /[\u00a0\u2007\u202f]/g;
const PH_INVIS_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
const PH_SEG_RE = /[,;|\n\r]|[ \t]+(?:lub|albo|oraz|i)[ \t]+/;
const PH_EXT_RE = /wew|ext|w\./;

/** Every dialable national number found in a raw phone string, in order, distinct. */
export function parsePhone(raw: string | null | undefined): ParsedPhone[] {
  const out: ParsedPhone[] = [];
  if (typeof raw !== 'string' || raw === '') return out;
  const t = raw.replace(PH_SPACE_RE, ' ').replace(PH_INVIS_RE, '').toLowerCase();
  for (let g of t.split(PH_SEG_RE)) {
    const m = PH_EXT_RE.exec(g);
    if (m) g = g.slice(0, m.index);
    const d = g.replace(/[^0-9]/g, '');
    const L = d.length;
    let c: string[];
    if (L === 9) c = [d];
    else if (L === 10 && d[0] === '0') c = [d.slice(1)];
    else if (L === 11 && d.slice(0, 2) === '48') c = [d.slice(2)];
    else if (L === 13 && d.slice(0, 4) === '0048') c = [d.slice(4)];
    else if (L === 18) c = [d.slice(0, 9), d.slice(9)];
    else continue;
    for (const n of c) {
      const cls = phoneClass(n);
      if (cls === 'zly') continue;
      if (!out.some((o) => o.n === n)) out.push({ n, cls });
    }
  }
  return out;
}

/** Distinct dialable numbers of `tel` followed by `phones[]` (V2.1.3 `nums`). */
export function recordNums(tel: string | null | undefined, phones: readonly string[] | null | undefined): ParsedPhone[] {
  const out: ParsedPhone[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    for (const p of parsePhone(raw)) {
      if (!seen.has(p.n)) {
        seen.add(p.n);
        out.push(p);
      }
    }
  };
  if (tel) add(tel);
  if (phones) for (const p of phones) add(p);
  return out;
}

/** `mobile` = first mobile number of `nums`, else null. */
export function firstMobile(nums: readonly ParsedPhone[]): string | null {
  for (const p of nums) if (p.cls === 'kom') return p.n;
  return null;
}

export const PHONE_CLASS_PL: Record<PhoneClass, string> = { kom: 'komórkowy', stac: 'stacjonarny', inny: 'inny', zly: 'nie do wybrania' };

/**
 * Phone quality 0-100 (SPEC 6.4). `cls` is the class of the number, `null` for a raw string that yields no number
 * (score 0, "nie do wybrania"). `owners` = number of distinct owners using the number (telShared semantics).
 */
export function phoneQuality(cls: PhoneClass | null, owners: number, stale: boolean): number {
  if (cls === null || cls === 'zly') return 0;
  let s = cls === 'kom' ? 100 : cls === 'stac' ? 85 : 60;
  if (owners >= 10) s -= 50;
  else if (owners >= 5) s -= 35;
  else if (owners >= 3) s -= 20;
  else if (owners === 2) s -= 10;
  if (stale) s -= 10;
  return Math.max(0, Math.min(100, s));
}

/** A mobile number listed by this many owners or more is a call centre, not a personal mobile (VAL-R3-6). */
export const MOBILE_SHARED_OWNERS = 5;

/** Short Polish note for a shared phone number ("prawdopodobnie centrala"). */
export function phoneSharedNote(owners: number): string | null {
  if (owners >= 10) return `centrala (używa go ${owners} podmiotów)`;
  if (owners >= 5) return `prawdopodobnie centrala (używa go ${owners} podmiotów)`;
  if (owners >= 2) return `wspólny z ${owners - 1} innym(i) podmiotem(ami)`;
  return null;
}

/* ------------------------------------------------------------------------------------------------------------------
 * NIP
 * ---------------------------------------------------------------------------------------------------------------- */
const NIP_W = [6, 5, 7, 2, 3, 4, 5, 6, 7];

/** NIP check result (SPEC 6.3). `nip` is digits only or null. */
export function nipStatus(nip: string | null | undefined): NipStatus {
  if (nip === null || nip === undefined || nip === '') return NIP_STATUS.NONE;
  if (!/^\d{10}$/.test(nip)) return NIP_STATUS.BAD_FORMAT;
  if (/^(\d)\1{9}$/.test(nip)) return NIP_STATUS.PLACEHOLDER;
  // real NIPs start with a tax-office code, never with 0: zero-padded values are placeholders (VAL-R3-9)
  if (nip.charCodeAt(0) === 48) return NIP_STATUS.PLACEHOLDER;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (nip.charCodeAt(i) - 48) * (NIP_W[i] ?? 0);
  const c = sum % 11;
  if (c === 10 || c !== nip.charCodeAt(9) - 48) return NIP_STATUS.CHECKSUM;
  return NIP_STATUS.OK;
}

export const NIP_STATUS_PL: Record<NipStatus, string> = {
  0: 'brak NIP',
  1: 'NIP poprawny',
  2: 'NIP ma zły format',
  3: 'NIP to wartość zastępcza (same takie same cyfry albo zera na początku)',
  4: 'NIP z błędną sumą kontrolną',
};

/** NIP usable as a shared-phone owner key: 10 digits, not one digit repeated, not starting with 0 (the offline tool's `nipKey`,
 *  no checksum; zero-padded placeholders are not owners, VAL-R3-9). */
export function nipKey(nip: string | null | undefined): string | null {
  if (typeof nip !== 'string' || !/^\d{10}$/.test(nip) || /^(\d)\1{9}$/.test(nip) || nip.charCodeAt(0) === 48) return null;
  return nip;
}

/* ------------------------------------------------------------------------------------------------------------------
 * Legal form, entity type, specialist clinics, names
 * ---------------------------------------------------------------------------------------------------------------- */
export type FormType = 'komercyjna' | 'publiczna' | 'inna';
const FT_PUBLIC_START = ['samodzielny publiczny zakład opieki zdrowotnej', 'jednostka budżetowa', 'instytut badawczy'];
const FT_COMM_START = ['działalność gospodarcza prowadzona przez osobę fizyczną', 'spółka', 'spółdzielnia'];
const JDG_START = 'działalność gospodarcza prowadzona przez osobę fizyczną';

/** public / commercial / other from the legal form name (V2.1.5); null forma gives null. */
export function formTypeOf(forma: string | null | undefined): FormType | null {
  if (typeof forma !== 'string') return null;
  const n = forma.toLowerCase();
  if (FT_PUBLIC_START.some((s) => n.startsWith(s)) || n.includes('co najmniej 51%')) return 'publiczna';
  if (n.includes('bez celu osiągania zysku') || n.includes('be celu osiągania zysku')) return 'inna';
  if (FT_COMM_START.some((s) => n.startsWith(s))) return 'komercyjna';
  return 'inna';
}

/** Distinct group-1 specialist clinic codes (dental 18xx excluded) among the active-komórka codes (V2.1.6). */
export function spec1Count(spec: readonly string[] | null | undefined): number {
  if (!spec) return 0;
  const seen = new Set<string>();
  for (const s of spec) {
    if (s.charCodeAt(0) !== 49 || s.slice(0, 2) === '18') continue;
    seen.add(s);
  }
  return seen.size;
}

/** Entity type (SPEC 6.1). */
export function entityType(input: { kind: 'p' | 'r'; src: string; forma: string | null; typ?: string | null; name?: string | null }): EntityType {
  if (input.kind === 'p') {
    if (formTypeOf(input.forma) === 'publiczna') return ENTITY_TYPE.PUBLICZNY;
    if (typeof input.forma === 'string' && input.forma.toLowerCase().startsWith(JDG_START)) return ENTITY_TYPE.JDG;
    if (input.forma === null || input.forma === undefined || input.forma === '') {
      // no legal form (VAL-9): infer from the name; a person's name alone is resolved by the caller (same NIP as a practice)
      const n = (input.name ?? '').toLowerCase().trim();
      if (/publiczny zakład|spzoz|samodzielny publiczny/.test(n)) return ENTITY_TYPE.PUBLICZNY;
      if (n.startsWith('osoba fizyczna')) return ENTITY_TYPE.JDG; // 'osoba fizyczna: Jan Kowalski' (VAL-R3-8)
    }
    return ENTITY_TYPE.PODMIOT_PRAWNY;
  }
  return input.typ === 'grupowa' || input.src.endsWith('g') ? ENTITY_TYPE.PRAKTYKA_GRUP : ENTITY_TYPE.PRAKTYKA_IND;
}

/** Types that describe natural persons (card label "Dane osoby fizycznej"); spółka cywilna is decided by the caller. */
export function isNaturalPersonType(t: EntityType): boolean {
  return t === ENTITY_TYPE.JDG || t === ENTITY_TYPE.PRAKTYKA_IND || t === ENTITY_TYPE.PRAKTYKA_GRUP;
}

const CLEAN_NAME_DEL = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
/** Name cleanup (V2.1.8): drop invisible characters, collapse whitespace, trim. */
export function cleanName(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(CLEAN_NAME_DEL, '').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------------------------------------------------------
 * E-mail
 * ---------------------------------------------------------------------------------------------------------------- */
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** Trim, strip `mailto:` and surrounding `<>`, lower-case. Returns '' for non-strings. */
export function normalizeEmail(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  for (let i = 0; i < 2; i++) {
    if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
    if (/^mailto:/i.test(s)) s = s.slice(7).trim();
  }
  return s.toLowerCase();
}

export function isValidEmail(normalized: string): boolean {
  return normalized.length <= 254 && EMAIL_RE.test(normalized);
}

export function emailDomain(normalized: string): string {
  const i = normalized.lastIndexOf('@');
  return i < 0 ? '' : normalized.slice(i + 1);
}

export type DomainClass = 'free' | 'typo' | 'generic' | 'social' | 'company';
export interface DomainInfo { cls: DomainClass; suggestion: string | null }
/** domain -> class, built from `generic_domain` (owner rows win over built-in rules) plus automatic generic domains. */
export type DomainTable = ReadonlyMap<string, { kind: 'free' | 'generic' | 'typo' | 'social'; suggestion: string | null }>;

export const FREE_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'wp.pl', 'o2.pl', 'onet.pl', 'onet.eu', 'op.pl', 'poczta.onet.pl', 'poczta.onet.eu', 'vp.pl',
  'interia.pl', 'interia.eu', 'poczta.fm', 'tlen.pl', 'go2.pl', 'gazeta.pl', 'yahoo.com', 'yahoo.pl', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'me.com', 'protonmail.com', 'proton.me', 'autograf.pl', 'buziaczek.pl', 'int.pl', 'neostrada.pl',
  'post.pl', 'pro.onet.pl', 'vip.onet.pl', 'poczta.wp.pl', 'xl.wp.pl', 'wp.eu', 'onet.com.pl', 'spoko.pl', 'hot.pl', 'list.pl',
  'adres.pl', 'data.pl',
  // ISP / portal mailboxes and free mailboxes that are not company domains (VAL-6)
  'aol.com', 'yahoo.co.uk', 'yahoo.it', 'hoga.pl', 'opoczta.pl', 'epoczta.pl', 'e-poczta.pl', 'poczta.pl', 'pocztaplus.pl',
  'upcpoczta.pl', 'pocztaemail.pl', 'europoczta.pl', 'vip.interia.pl', 'poczta.interia.pl', 'poczta.neostrada.pl',
  'poczta.internetdsl.pl', 'esculap.pl', 'eskulap.pl', 'orange.pl', 'plusnet.pl', 'idsl.pl',
  'ka.onet.pl', 'za.onet.pl', 'ns.onet.pl', 'le.onet.pl',
  // more free / ISP / portal mailboxes (VAL-R2-4)
  'mail.ru', 'ukr.net', 'windowslive.com', 'yahoo.de', 'yahoo.fr', 'yahoo.es', 'protonmail.ch', 'gmx.com', 'gmx.net', 'aol.pl',
  'mail.com', 'ymail.com', 'konto.pl', 'prokonto.pl', 'box43.pl', 'eskrzynka.pl', '1gb.pl', '10g.pl', 'go3.pl', 'internetdsl.pl',
  'pnet.pl', 'inet.com.pl', 'inetia.pl', 'rubikon.pl', 'dilnet.wroc.pl', 'life.pl', 'os.pl', 'oz.pl', 'dentonet.pl',
  // ISP / portal mailboxes under shared suffixes; their sub-domains are mailbox hosts too (VAL-R3-7)
  'ape.net.pl', 'alias.net.pl', 'ak.net.pl', 'toya.net.pl', 'uznam.net.pl', 'krynica.net.pl', 'malbork.net.pl', 'konin.lm.pl',
  'creator.wroc.pl', 'gryf.info.pl', 'amorki.pl', 'mierzeja.pl', '2com.pl', 'tpnet.pl', 'mail.pl', 'opoka.org.pl', 'kkw.com.pl',
  // city portals and an ISP whose mailboxes link unrelated local podmioty (VAL-R4-3)
  'elblag.com.pl', 'sanok.com.pl', 'grudziadz.com.pl', 'tenit.com.pl', 'sanatoria.com.pl',
  // a long-standing ISP whose short name the 1-2 character rule would call a typo (VAL-R5-4)
  'iq.pl',
];
export const TYPO_DOMAINS: Readonly<Record<string, string>> = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.pl': 'gmail.com', 'gmail.con': 'gmail.com', 'gmal.com': 'gmail.com',
  'gamil.com': 'gmail.com', 'wp.p': 'wp.pl', '0net.pl': 'onet.pl', 'intera.pl': 'interia.pl', 'o2.p': 'o2.pl',
  'gmail.com.pl': 'gmail.com', 'gemail.com': 'gmail.com', 'gmali.com': 'gmail.com', 'interia.com': 'interia.pl',
  'poczta.fm.pl': 'poczta.fm', 'pocztafm.pl': 'poczta.fm', 'onet.poczta.pl': 'poczta.onet.pl',
  // transpositions / deletions of onet.pl (not 'net.pl': a real ISP)
  'oent.pl': 'onet.pl', 'onte.pl': 'onet.pl', 'noet.pl': 'onet.pl', 'ont.pl': 'onet.pl', 'oet.pl': 'onet.pl',
  // typos the rules below cannot derive (VAL-R2-4)
  'xlwp.pl': 'wp.pl', 'onwt.pl': 'onet.pl', 'o.2.pl': 'o2.pl', 'oo2.pl': 'o2.pl', 'proonet.pl': 'onet.pl', 'plsnet.pl': 'onet.pl',
  'tlan.pl': 'tlen.pl', 'poczta.internetds.pl': 'poczta.internetdsl.pl', 'tlen.pl.pl': 'tlen.pl', 'poczta.onrt.pl': 'poczta.onet.pl',
  'poczta.onet': 'poczta.onet.pl', 'poczta.one.pl': 'poczta.onet.pl', 'pocta.onet.pl': 'poczta.onet.pl',
  // zero for the letter o (the most common typo domain of the register, VAL-R3-4)
  '02.pl': 'o2.pl',
  // VAL-R4-3
  'poczta.net.pl': 'onet.pl',
};
/** Fuzzy typo matching (edit distance 1) only against long popular bases: short ones (wp.pl, o2.pl, op.pl) hit real ISPs. */
const TYPO_BASES = ['gmail.com', 'interia.pl', 'protonmail.com'];
const GENERIC_EXACT = new Set(['gov.pl', 'mp.pl', 'zoz.org.pl', 'home.pl', 'webmedia.com.pl', 'bitserwis.pl', 'strazgraniczna.pl',
  'lzlrp.pl', 'porozumieniepodkarpackie.pl', 'teb-edukacja.pl']);
/** Only government suffixes are generic: companies under .net.pl / .com.pl / .edu.pl are real organisations (VAL-R3-1, VAL-R3-7). */
const GENERIC_SUFFIX = ['.gov.pl', '.mil.pl'];
/**
 * Medical universities: staff addresses of one university link unrelated practices and companies, never a network
 * (VAL-R4-3). Like a `generic` row of the database, each covers its sub-domains. Twin of the seed in core_tables.sql.
 */
export const GENERIC_UNIVERSITIES: readonly string[] = ['gumed.edu.pl', 'ump.edu.pl', 'umb.edu.pl', 'wum.edu.pl', 'sum.edu.pl', 'pum.edu.pl',
  'umw.edu.pl', 'umed.wroc.pl', 'umed.lodz.pl', 'umlub.pl', 'uj.edu.pl', 'cm-uj.krakow.pl', 'cm.umk.pl', 'umk.pl'];
/** sanepid hosts (psse-*.pl, wsse.*.pl ...) are shared by unrelated stations; so are the regional NFZ branch domains (VAL-R3-7) */
const GENERIC_SANEPID = /^(psse|wsse)[.-]|^nfz-[a-z]+\.pl$/;
/**
 * Public second-level suffixes under which anyone registers a domain (VAL-R3-1). A `generic` row for one of them matches only
 * that exact domain, never its sub-domains, so alab.com.pl stays a company. Twin of SQL `private.public_suffix`.
 */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set(['com.pl', 'net.pl', 'org.pl', 'edu.pl', 'info.pl', 'biz.pl', 'waw.pl', 'lm.pl', 'med.pl',
  'priv.pl', 'nom.pl', 'shop.pl', 'sklep.pl', 'pc.pl', 'tm.pl', 'wroc.pl', 'gda.pl', 'krakow.pl', 'poznan.pl', 'lodz.pl', 'szczecin.pl',
  'katowice.pl', 'lublin.pl', 'bialystok.pl', 'torun.pl', 'olsztyn.pl', 'rzeszow.pl', 'opole.pl', 'kielce.pl', 'bydgoszcz.pl', 'gliwice.pl',
  'gdynia.pl', 'sopot.pl', 'com', 'net', 'org', 'pl', 'eu']);

export const SOCIAL_HOSTS: readonly string[] = [
  'facebook.com', 'fb.com', 'm.facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com',
  'znanylekarz.pl', 'google.com', 'goo.gl', 'business.site',
  // hosts whose identity is in the path (normalizeWww drops it) and portals listing unrelated practices (VAL-6)
  'sites.google.com', 'osoz.pl', 'lekarzebezkolejki.pl', 'stomatolog.pl', 'linktr.ee',
  // path-identity hosts and portals (VAL-R2-5)
  'google.pl', 'mail.google.com', 'republika.pl', 'webd.pl', 'znajdzfizjoterapeute.pl', 'kliniki.pl', 'dobrylekarz.pro', 'konopnaterapia.com',
  // a portal whose identity is in the path (/komunalni/, /bartodzieje/), VAL-R4-3
  'medycyna.net.pl',
];

const FREE_SET = new Set(FREE_DOMAINS);
const SOCIAL_SET = new Set(SOCIAL_HOSTS);
/** SOCIAL_HOSTS whose sub-domains are portal pages too (sanatorium.webd.pl, pacjent.konopnaterapia.com, gabinet.business.site:
 *  Google's discontinued free sites, RD2-5); used for e-mail domains and WWW fields alike. */
const SOCIAL_PARENTS = ['webd.pl', 'konopnaterapia.com', 'business.site'];
const isSocialHost = (d: string): boolean => SOCIAL_SET.has(d) || SOCIAL_PARENTS.some((s) => d.endsWith('.' + s));
/**
 * Generic public suffixes that are a typo when used as a whole e-mail domain (x@com.pl). City suffixes (sopot.pl, krakow.pl)
 * are not: Sopot's schools use @sopot.pl (VAL-R5-3). Twin of the seed's `typo` rows without a suggestion.
 */
const BARE_SUFFIX_TYPOS: ReadonlySet<string> = new Set(['com.pl', 'net.pl', 'org.pl', 'edu.pl', 'waw.pl']);
/** Free domains a 3 character '.pl' typo is suggested to; any other near miss (kos.pl ~ os.pl) gets no suggestion (VAL-R5-4). */
const SHORT_TYPO_TARGETS = ['wp.pl', 'o2.pl', 'op.pl', 'vp.pl'];

/** The label of `d` after its last dot, and the rest ('wp.plo' -> ['plo', 'wp']); rest is '' for a one-label name. */
function splitLast(d: string): [string, string] {
  const i = d.lastIndexOf('.');
  return i < 0 ? [d, ''] : [d.slice(i + 1), d.slice(0, i)];
}

/**
 * Typo of a free mail domain that is not itself listed (VAL-R2-4): (a) the last label is one edit away from the free domain's
 * (wp.plo, wp.pll, op.pll, wp.pi, poczta.gm, poczta.fml); (b) the first label is one edit away from 'poczta' in front of a
 * free or typo domain (poczt.onet.pl, pocvzta.onet.pl, poczta.wpl.pl); (c) a 1-2 character name before '.pl' (no
 * suggestion: '' — "sprawdź domenę", VAL-R3-4), or a 3 character one at distance 1 from a free domain (wpl.pl, oo2.pl);
 * (d) any '.gmail.com' sub-domain. Returns the suggested domain, '' for a typo without a suggestion, or null.
 */
function freeTypoOf(d: string): string | null {
  if (d.endsWith('.gmail.com')) return 'gmail.com';
  const [last, base] = splitLast(d);
  if (base.length >= 2) {
    for (const f of FREE_DOMAINS) {
      const [fl, fb] = splitLast(f);
      if (fb === base && fl !== last && editDistance(last, fl, 1) === 1) return f;
    }
  }
  const dot = d.indexOf('.');
  if (dot > 0 && editDistance(d.slice(0, dot), 'poczta', 1) <= 1) {
    const rest = d.slice(dot + 1);
    const restTypo = FREE_SET.has(rest) ? null : freeTypoOf(rest);
    if (restTypo !== null) return restTypo;
    if (FREE_SET.has(rest) && d.slice(0, dot) !== 'poczta') return rest;
  }
  if (d.endsWith('.pl') && d.indexOf('.') === d.length - 3) {
    const name = d.slice(0, -3);
    if (name.length <= 2) return '';
    if (name.length === 3) {
      for (const f of FREE_DOMAINS) if (f.endsWith('.pl') && editDistance(d, f, 1) === 1) return SHORT_TYPO_TARGETS.includes(f) ? f : '';
    }
  }
  return null;
}

/** Damerau-Levenshtein (optimal string alignment) distance, bounded: returns max+1 when above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const al = a.length, bl = b.length;
  const d: number[][] = [];
  for (let i = 0; i <= al; i++) {
    d.push(new Array<number>(bl + 1).fill(0));
    (d[i] as number[])[0] = i;
  }
  for (let j = 0; j <= bl; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= al; i++) {
    const row = d[i] as number[], prev = d[i - 1] as number[];
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
      row[j] = v;
    }
  }
  return (d[al] as number[])[bl] as number;
}

/**
 * Every web host of a set of WWW fields and each of its parent domains with at least two labels (rejestracja.cos.pl gives
 * rejestracja.cos.pl and cos.pl). An e-mail domain in this set is somebody's own website, never a typo (VAL-R3-4). Public
 * suffixes (com.pl, net.pl, waw.pl ...) are left out: nobody's website is "com.pl", and x@com.pl is a typo (VAL-R4-3).
 */
export function hostDomains(hosts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const h of hosts) {
    for (let d = h; d.includes('.'); d = d.slice(d.indexOf('.') + 1)) if (!PUBLIC_SUFFIXES.has(d)) out.add(d);
  }
  return out;
}

/**
 * Class of an e-mail domain. A row of `table` (owner / seeded / automatic) wins over the built-in rules. `webDomains`
 * (see `hostDomains`) are domains of somebody's WWW: a rule-derived typo among them is a company domain (cos.pl, wpr.pl).
 */
export function classifyDomain(domain: string, table?: DomainTable, webDomains?: ReadonlySet<string>): DomainInfo {
  const d = domain.toLowerCase();
  const row = table?.get(d);
  if (row) return { cls: row.kind, suggestion: row.suggestion };
  // a `generic` row covers its sub-domains too (gov.pl covers sanepid.gov.pl), as the database's domain_class does, except a
  // row for a public suffix (com.pl), which never covers the companies registered under it (VAL-R3-1)
  if (table) {
    for (let i = d.indexOf('.'); i >= 0; i = d.indexOf('.', i + 1)) {
      const parent = d.slice(i + 1);
      if (!parent.includes('.')) break;
      const anc = table.get(parent);
      if (anc?.kind === 'generic' && !PUBLIC_SUFFIXES.has(parent)) return { cls: 'generic', suggestion: null };
    }
  }
  const ruleTypo = (suggestion: string): DomainInfo =>
    webDomains?.has(d) ? { cls: 'company', suggestion: null } : { cls: 'typo', suggestion: suggestion || null };
  if (FREE_SET.has(d)) return { cls: 'free', suggestion: null };
  const typo = TYPO_DOMAINS[d];
  if (typo) return { cls: 'typo', suggestion: typo };
  // a bare generic suffix (x@com.pl, x@waw.pl) is a typo without a suggestion; the seed has the same rows (VAL-R4-3, VAL-R5-3)
  if (BARE_SUFFIX_TYPOS.has(d)) return { cls: 'typo', suggestion: null };
  if (isSocialHost(d)) return { cls: 'social', suggestion: null };
  // a sub-domain of a free mail domain is a mailbox host, not a company (x.wp.pl, x.interia.pl)
  for (let i = d.indexOf('.'); i >= 0; i = d.indexOf('.', i + 1)) {
    const parent = d.slice(i + 1);
    if (parent.includes('.') && FREE_SET.has(parent)) {
      const ft = freeTypoOf(d);
      return ft !== null ? ruleTypo(ft) : { cls: 'free', suggestion: null };
    }
  }
  if (GENERIC_EXACT.has(d) || GENERIC_SUFFIX.some((s) => d.endsWith(s)) || GENERIC_SANEPID.test(d)
    || GENERIC_UNIVERSITIES.some((u) => d === u || d.endsWith('.' + u))) return { cls: 'generic', suggestion: null };
  const ft0 = freeTypoOf(d);
  if (ft0 !== null) return ruleTypo(ft0);
  // a domain one edit away from a long popular free domain (gmail.com, interia.pl) that is not itself listed
  if (d.length >= 7 && d.length <= 20) {
    for (const base of TYPO_BASES) {
      if (editDistance(d, base, 1) === 1) return ruleTypo(base);
    }
  }
  return { cls: 'company', suggestion: null };
}

const ROLE_FRONT = ['rejestracja', 'rejestr', 'recepcja', 'zapisy', 'przychodnia', 'poradnia', 'gabinet'];
const ROLE_OFFICE = ['biuro', 'sekretariat', 'kontakt', 'info', 'office', 'poczta', 'administracja', 'kancelaria', 'centrala', 'mail', 'admin'];

/** 'front' (rejestracja@ ...), 'office' (biuro@ ...) or null for a personal / unknown mailbox. */
export function emailRole(normalized: string): 'front' | 'office' | null {
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return null;
  let local = normalized.slice(0, at);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (ROLE_FRONT.some((p) => local.startsWith(p))) return 'front';
  if (ROLE_OFFICE.some((p) => local.startsWith(p))) return 'office';
  return null;
}

/**
 * E-mail quality 0-100 (SPEC 6.4). `sharedAccounts` = number of accounts using this address. Returns 0 for invalid
 * syntax. `domains` supplies owner-edited and automatic generic domains.
 */
export function emailQuality(email: string, sharedAccounts: number, stale: boolean, domains?: DomainTable, webDomains?: ReadonlySet<string>): number {
  const e = normalizeEmail(email);
  if (!isValidEmail(e)) return 0;
  const dom = classifyDomain(emailDomain(e), domains, webDomains);
  let s = 100;
  if (dom.cls === 'typo') s = 10;
  if (dom.cls === 'free') s -= 15;
  if (dom.cls === 'generic') s -= 5;
  const role = emailRole(e);
  if (role === 'front') s -= 15;
  else if (role === 'office') s -= 10;
  if (sharedAccounts >= 6) s -= 20;
  else if (sharedAccounts >= 2) s -= 10;
  if (stale) s -= 10;
  return Math.max(0, Math.min(100, s));
}

export function qualityLabel(score: number | null): 'dobry' | 'średni' | 'słaby' | null {
  if (score === null) return null;
  return score >= 75 ? 'dobry' : score >= 45 ? 'średni' : 'słaby';
}

/* ------------------------------------------------------------------------------------------------------------------
 * WWW
 * ---------------------------------------------------------------------------------------------------------------- */
const WWW_JUNK = new Set(['-', ',', 'brak', 'brak wpisu', 'nie dotyczy', 'n/d', 'nd', 'ul.', 'www', 'http', 'https']);

export interface WwwInfo {
  /** normalised host, or null when invalid */
  host: string | null;
  status: 'ok' | 'invalid' | 'social';
  /** Polish reason when invalid */
  reason: string | null;
  /** normalised e-mail address typed into the WWW field (VAL-8), else null */
  email?: string | null;
}

const ADDRESS_RE = /(^|[\s,])(ul\.?|ulica|al\.|aleja|pl\.|plac|os\.)\s|\d{2}-\d{3}|\s\d+[a-z]?(\/\d+[a-z]?)?\s*(,|$)/;

/** Normalise a WWW field: lower-case, no scheme, `www.`/`www2.`, port, path, query, fragment, trailing dot. */
export function normalizeWww(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^www2?\./, '');
  s = s.split(/[/?#]/)[0] ?? '';
  s = s.replace(/:\d*$/, '');
  s = s.replace(/\.+$/, '');
  return s;
}

/** Validity and class of a WWW field (SPEC 6.4). */
export function wwwQuality(raw: string | null | undefined): WwwInfo {
  if (typeof raw !== 'string' || raw.trim() === '') return { host: null, status: 'invalid', reason: 'puste pole' };
  const trimmed = raw.trim().toLowerCase();
  if (WWW_JUNK.has(trimmed)) return { host: null, status: 'invalid', reason: 'wartość zastępcza' };
  if (trimmed.includes('@')) {
    const mail = normalizeEmail(raw);
    return { host: null, status: 'invalid', reason: 'adres e-mail w polu WWW', email: isValidEmail(mail) ? mail : null };
  }
  if (/\s/.test(trimmed)) {
    return { host: null, status: 'invalid', reason: ADDRESS_RE.test(trimmed) ? 'adres w polu WWW' : 'zawiera spacje' };
  }
  const host = normalizeWww(raw);
  if (host === '' || WWW_JUNK.has(host)) return { host: null, status: 'invalid', reason: 'wartość zastępcza' };
  if (!host.includes('.')) return { host: null, status: 'invalid', reason: 'brak domeny' };
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (!/^[a-z]{2,24}$/.test(tld)) return { host: null, status: 'invalid', reason: 'nieprawidłowa końcówka domeny' };
  if (!/^[a-z0-9.-]+$/.test(host)) return { host: null, status: 'invalid', reason: 'niedozwolone znaki' };
  if (isSocialHost(host)) return { host, status: 'social', reason: null };
  return { host, status: 'ok', reason: null };
}

/* ------------------------------------------------------------------------------------------------------------------
 * Staleness, flags
 * ---------------------------------------------------------------------------------------------------------------- */
/** `stan` is null or not after `staleBefore` (the register migration date): the record has not been touched since. */
export function isStale(stan: string | null | undefined, staleBefore: string): boolean {
  return !stan || stan <= staleBefore;
}

export const QFLAG_LABEL_PL: Array<[number, string]> = [
  [QFLAG.NIP_MISSING, 'brak NIP'],
  [QFLAG.NIP_BAD_FORMAT, 'NIP ma zły format'],
  [QFLAG.NIP_PLACEHOLDER, 'NIP to wartość zastępcza'],
  [QFLAG.NIP_CHECKSUM, 'NIP z błędną sumą kontrolną'],
  [QFLAG.NO_CONTACT, 'brak działającego kontaktu'],
  [QFLAG.EMAIL_INVALID, 'adres e-mail jest niepoprawny'],
  [QFLAG.EMAIL_TYPO, 'możliwa literówka w e-mailu'],
  [QFLAG.EMAIL_FREE, 'e-mail na darmowej poczcie (nie firmowy)'],
  [QFLAG.EMAIL_ROLE, 'e-mail ogólny (rejestracja, biuro…)'],
  [QFLAG.EMAIL_SHARED, 'ten sam e-mail ma więcej niż jeden podmiot'],
  [QFLAG.PHONE_UNPARSEABLE, 'numer telefonu nie nadaje się do wybrania'],
  [QFLAG.PHONE_SHARED, 'ten sam telefon ma kilka podmiotów'],
  [QFLAG.PHONE_SWITCHBOARD, 'telefon wygląda na centralę'],
  [QFLAG.WWW_INVALID, 'pole WWW jest niepoprawne'],
  [QFLAG.WWW_SOCIAL, 'WWW to profil społecznościowy'],
  [QFLAG.STALE, 'dane nie zmieniały się od migracji rejestru (2023-11-10)'],
  [QFLAG.REG_DUPLICATE, 'ten sam numer księgi występuje w rejestrze dwa razy'],
  [QFLAG.GROUP_NIP_IS_PARTNER, 'brak własnego NIP praktyki (podany NIP wspólnika)'],
  [QFLAG.INACTIVE, 'wpis nieaktywny w rejestrze'],
  [QFLAG.ACCOUNT_CHECK, 'ten sam NIP mają różne podmioty lub osoby (do sprawdzenia)'],
  [QFLAG.EMAIL_FROM_WWW, 'e-mail z pola WWW'],
  [QFLAG.MOBILE_SHARED, 'komórka używana przez wiele podmiotów (infolinia), nie do SMS'],
];

/** Polish descriptions of the set bits of `qflags` (optionally restricted to a mask). */
export function qflagLabels(qflags: number, mask?: number): string[] {
  return QFLAG_LABEL_PL.filter(([bit]) => (qflags & bit) !== 0 && (mask === undefined || (mask & bit) !== 0)).map(([, l]) => l);
}
