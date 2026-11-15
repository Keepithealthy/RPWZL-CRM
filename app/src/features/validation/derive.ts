/**
 * Whole-file validation: accounts ("kto jest kim"), derived fields, quality flags and network / duplicate proposals
 * (SPEC.md 6.2, 6.5, 6.6). Pure; runs in the import worker over the light per-entry records of the file.
 */
import {
  ENTITY_TYPE, NIP_STATUS, QFLAG, SOURCES, type DerivedFields, type EntityType, type ImportProposalRow, type Kind,
  type ProposalKind, type SourceId, type ValDecisions, type ValidationParams,
} from '../../lib/contract';
import { hash64Hex } from '../import/sha256';
import {
  classifyDomain, emailDomain, emailQuality, emailRole, entityType as entityTypeOf, formTypeOf, hostDomains, isStale, isValidEmail,
  nipKey, nipStatus, normalizeEmail, phoneClass, phoneQuality, recordNums, spec1Count, wwwQuality, type FormType,
} from './rules';
import { MOBILE_SHARED_OWNERS } from './rules';

export const DEFAULT_PARAMS: ValidationParams = {
  genericDomainAccounts: 30,
  emailClusterMax: 30,
  domainClusterMax: 50,
  wwwClusterMax: 50,
  phoneClusterMax: 3,
  staleBefore: '2023-11-10',
};

/** What the validation needs to know about one register entry (a few hundred bytes; the full record is not kept). */
export interface Light {
  kind: Kind;
  src: SourceId;
  /** 16 hex digits, SHA-256 of the register key */
  keyHash: string;
  /** `${src}|${org}|${ks}`, shared by entries that collide on the book number */
  regGroup: string;
  /** more than one entry has this regGroup */
  regDup: boolean;
  name: string | null;
  nip: string | null;
  forma: string | null;
  typ: string | null;
  status: string;
  stan: string | null;
  woj: string | null;
  email: string | null;
  /** all e-mails as in the register (podmioty: `emails`; practices: `[email]` when present) */
  emails: string[];
  tel: string | null;
  phones: string[];
  www: string | null;
  /** NIPs of partners: podmiot `d.sc[][1]`, group practice `d.w[].nip` */
  partnerNips: string[];
  /** the practice's own professional licence number (practices: `d.npwz`) */
  npwz: string[];
  /** licence numbers of a group practice's partners (`d.w[].npwz`); they identify other people, never the practice itself (VAL-R2-1) */
  partnerNpwz?: string[];
  /** codes of the `spec` facet (podmioty) for `spec1` */
  spec: string[];
  /** the e-mail in `emails` was typed into the WWW field (practices only, VAL-8) */
  emailFromWww?: boolean;
}

export interface DeriveResult {
  derived: DerivedFields[];
  proposals: ImportProposalRow[];
  /** domains marked generic automatically (used by >= genericDomainAccounts accounts in >= 3 voivodeships) */
  autoGenericDomains: string[];
}


function buildDomainTable(decisions: ValDecisions | null): Map<string, { kind: 'free' | 'generic' | 'typo' | 'social'; suggestion: string | null }> {
  const t = new Map<string, { kind: 'free' | 'generic' | 'typo' | 'social'; suggestion: string | null }>();
  for (const g of decisions?.genericDomains ?? []) t.set(g.domain.toLowerCase(), { kind: g.kind, suggestion: g.suggestion });
  return t;
}

const NAME_TOKEN_RE = /[^\p{L}\p{N}]+/u;

const nameTokenList = (name: string | null): string[] => (name ?? '').toLowerCase().split(NAME_TOKEN_RE).filter(Boolean);

/** Letters that NFD does not decompose; twin of the extra pairs in SQL private.name_tokens. */
const FOLD_EXTRA: Readonly<Record<string, string>> = { ł: 'l', ø: 'o', đ: 'd', ı: 'i', ħ: 'h', ŧ: 't', ß: 'ss', æ: 'ae', œ: 'oe' };

/** Name tokens with diacritics folded ('Śliwa' / 'Sliwa', 'Tešťák' / 'Testak' are one token), for comparing people across
 *  entries. Twin of SQL private.name_tokens (VAL-R5-5). */
const foldedTokenList = (name: string | null): string[] =>
  nameTokenList((name ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[łøđıħŧßæœ]/g, (c) => FOLD_EXTRA[c] ?? c));

/** Re-exported for the worker's callers; defined in rules.ts so the card does not load this module (RD2-4). */
export { MOBILE_SHARED_OWNERS };

/** Words that say what kind of facility it is, not who it is; they never make two accounts "the same organisation" (VAL-R2-5). */
const NAME_STOP_WORDS = new Set(['praktyka', 'praktyki', 'lekarska', 'lekarza', 'gabinet', 'gabinety', 'indywidualna', 'indywidualne', 'grupowa',
  'medyczne', 'medyczny', 'centrum', 'przychodnia', 'zakład', 'opieki', 'zdrowotnej', 'specjalistyczna', 'specjalistyczny', 'stomatologiczny',
  'stomatologiczna', 'niepubliczny', 'niepubliczna', 'zdrowia', 'usługi', 'specjalistyczne', 'dentystyczny', 'dentystyczna', 'fizjoterapii',
  'pielęgniarska', 'pielęgniarki', 'położnej', 'lekarz', 'lekarzy', 'dentysta', 'spółka', 'ograniczoną', 'odpowiedzialnością']);

/** Token `a` stands for token `b`: equal, or an initial of it ('a' / 'anna'). */
const tokenMatches = (a: string, b: string): boolean => a === b || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b));

/** Every token of the smaller name has its own counterpart in the bigger one ('A. B. C.' contains 'A. C.'). */
function nestedNames(small: readonly string[], big: readonly string[]): boolean {
  const used = new Set<number>();
  return small.every((t) => {
    const j = big.findIndex((u, k) => !used.has(k) && tokenMatches(t, u));
    if (j < 0) return false;
    used.add(j);
    return true;
  });
}

/** Number of different people among the names after collapsing names that contain one another (middle names, initials,
 *  the same person registered with two professions); VAL-R2-3. */
function distinctPersons(names: readonly string[][]): number {
  const reps: string[][] = [];
  for (const nm of [...names].sort((a, b) => b.length - a.length)) {
    if (!reps.some((r) => nestedNames(nm, r))) reps.push(nm);
  }
  return reps.length;
}

/** Folded name tokens without a leading 'osoba fizyczna' (a register prefix of sole traders, VAL-R3-8). */
export function personTokens(name: string | null): string[] {
  const t = foldedTokenList(name);
  return t[0] === 'osoba' && t[1] === 'fizyczna' ? t.slice(2) : t;
}

/**
 * Two names (folded tokens) can name the same person (VAL-R5-1, VAL-R5-2): one nests in the other (middle names, initials, a
 * business name around the person's name), or the first token of either, when it is not an initial (the first name), occurs
 * among the tokens of the other (a changed surname: 'Anna Test' / 'Anna Maria Próba'). A shared surname alone is somebody
 * else ('Robert Test' / 'Urszula Test'), and so is a different first name ('Ewa A' / 'Jan A'). With `nestOnly` the first-name
 * branch is off: between two individual practices of the same profession that carry different licence numbers a shared first
 * name is not enough ('Anna Testowa' / 'Anna Próbna' are two people; VAL-R6-1). Twin of SQL private.same_person.
 */
export function samePersonTokens(a: readonly string[], b: readonly string[], nestOnly = false): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (nestedNames(a, b) || nestedNames(b, a)) return true;
  if (nestOnly) return false;
  const fa = a[0] as string, fb = b[0] as string;
  return (fa.length > 1 && b.includes(fa)) || (fb.length > 1 && a.includes(fb));
}

/** A licence number that identifies somebody (at least 4 characters, not one repeated character); twin of SQL private.licence. */
export function licenceOf(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  return v.length < 4 || /^(.)\1*$/.test(v) ? null : v;
}

/** One entry of an account, as `detachedPractices` needs it. */
export interface AccountEntry {
  /** caller's handle (index or id), returned for the detached entries */
  ref: number;
  type: EntityType;
  name: string | null;
  /** licence profession of an individual practice ('lek', 'piel', 'fizjo', 'diag') */
  profession: string;
  /** the practice's own licence number (`licenceOf`), else null */
  licence: string | null;
  primary: boolean;
}

/**
 * The individual practices that "to różne podmioty" detaches from an account without a company (a JDG with practices, or
 * practices only): those of somebody else than the reference person (the JDG's names, else the account primary). A practice
 * stays when `samePersonTokens` matches it with the reference, or when it carries a reference licence number of its profession
 * (the primary practice's; with a JDG, those of the practices whose names nest with a JDG name). A different number of the same
 * register is not another person by itself (doctor and dentist, nurse and midwife numbers). Twin of SQL
 * private.minority_entries (VAL-R5-1, VAL-R5-2, VAL-R6-1: no first-name match between two practices of one profession with different licence numbers); an account is ACCOUNT_CHECK exactly when this is not empty, so the worker and
 * the database agree.
 */
export function detachedPractices(entries: readonly AccountEntry[]): number[] {
  const hasJdg = entries.some((e) => e.type === ENTITY_TYPE.JDG);
  const refEntries = entries.filter((e) => (hasJdg ? e.type === ENTITY_TYPE.JDG : e.primary));
  const ref = refEntries.map((e) => personTokens(e.name));
  const practices = entries.filter((e) => e.type === ENTITY_TYPE.PRAKTYKA_IND).map((e) => ({ e, t: personTokens(e.name) }));
  const refLicences = new Set<string>();
  for (const { e, t } of practices) {
    if (!e.licence) continue;
    const isRef = hasJdg ? t.length > 0 && ref.some((r) => r.length > 0 && (nestedNames(r, t) || nestedNames(t, r))) : e.primary;
    if (isRef) refLicences.add(e.profession + ':' + e.licence);
  }
  return practices
    .filter(({ e, t }) => (hasJdg || !e.primary) && !(e.licence && refLicences.has(e.profession + ':' + e.licence))
      // nest-only between two practices of one profession with different valid licence numbers (VAL-R6-1)
      && !ref.some((r, i) => {
        const re = refEntries[i] as AccountEntry;
        return samePersonTokens(r, t, re.type === ENTITY_TYPE.PRAKTYKA_IND && re.profession === e.profession && !!re.licence && !!e.licence && re.licence !== e.licence);
      }))
    .map(({ e }) => e.ref);
}

/** Profession namespace of a licence number: the numbers of the four professions come from separate series (VAL-3). */
function professionOf(src: string): string {
  if (src.startsWith('Rpzp')) return 'piel';
  if (src.startsWith('Rpz')) return 'lek';
  if (src.startsWith('Rpf')) return 'fizjo';
  if (src.startsWith('Rpdl')) return 'diag';
  return 'inny';
}

/** Commercial partnership forms that register the same company as podmiot and as group practice (VAL-5). */
const PARTNERSHIP_FORMA = /^(spółka cywilna|spółka jawna|spółka partnerska)/i;

function setSize(m: Map<string, Set<string>>, k: string): number {
  return m.get(k)?.size ?? 0;
}

function add(m: Map<string, Set<string>>, k: string, v: string): void {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(v);
}

export function groupKeyOf(members: readonly string[]): string {
  return hash64Hex([...members].sort().join('\n'));
}

export function deriveAll(lights: readonly Light[], decisions: ValDecisions | null): DeriveResult {
  const params: ValidationParams = { ...DEFAULT_PARAMS, ...(decisions?.params ?? {}) };
  const detach = new Set(decisions?.detach ?? []);
  const attach = new Map((decisions?.attach ?? []).map((a) => [a.keyHash, a.accountKey]));
  const table = buildDomainTable(decisions);
  const n = lights.length;

  /* ---- 1. NIP status, entity type, account key ---- */
  const nipSt = new Array<number>(n);
  const etype = new Array<EntityType>(n);
  const accKey = new Array<string>(n);
  const accounts = new Map<string, number[]>();
  // practice names by NIP: a podmiot without a legal form whose name nests with a practice's name under the same NIP is a
  // sole trader (VAL-9; middle names and initials allowed, VAL-R3-8)
  const practiceNames = new Map<string, string[][]>();
  for (const l of lights) {
    if (l.kind === 'r' && l.src !== 'Rpzg' && !l.src.endsWith('g') && nipKey(l.nip)) {
      const list = practiceNames.get(l.nip as string);
      if (list) list.push(foldedTokenList(l.name));
      else practiceNames.set(l.nip as string, [foldedTokenList(l.name)]);
    }
  }
  const samePersonAsPractice = (l: Light): boolean => {
    const own = foldedTokenList(l.name);
    if (own.length < 2 || !l.nip) return false;
    return (practiceNames.get(l.nip) ?? []).some((p) => p.length >= 2 && (nestedNames(own, p) || nestedNames(p, own)));
  };
  // The index fills a group practice's NIP with the first partner's NIP when the practice has none of its own
  // (RPWDL SPEC); such a value identifies the partner, not the practice (VAL-1).
  const ownNip = (l: Light, t: EntityType): string | null => (t === ENTITY_TYPE.PRAKTYKA_GRUP && l.nip && l.partnerNips.includes(l.nip) ? null : l.nip);
  const nipOwn = new Array<string | null>(n);
  for (let i = 0; i < n; i++) {
    const l = lights[i] as Light;
    const st = nipStatus(l.nip);
    nipSt[i] = st;
    let t = entityTypeOf({ kind: l.kind, src: l.src, forma: l.forma, typ: l.typ, name: l.name });
    if (t === ENTITY_TYPE.PODMIOT_PRAWNY && !l.forma && samePersonAsPractice(l)) t = ENTITY_TYPE.JDG;
    etype[i] = t;
    nipOwn[i] = ownNip(l, t);
    let key = st === NIP_STATUS.OK && nipOwn[i] ? 'n:' + l.nip : 'e:' + l.keyHash;
    const att = attach.get(l.keyHash);
    if (detach.has(l.keyHash)) key = 'e:' + l.keyHash;
    else if (att) key = att;
    accKey[i] = key;
    const g = accounts.get(key);
    if (g) g.push(i);
    else accounts.set(key, [i]);
  }

  /* ---- 2. accounts: size, primary, type check ---- */
  const accSize = new Array<number>(n);
  const isPrimary = new Array<boolean>(n).fill(false);
  const accountCheck = new Set<string>();
  const contactScore = (i: number): number => {
    const l = lights[i] as Light;
    return (l.tel ? 4 : 0) + (l.email || l.emails.length ? 2 : 0) + (l.www ? 1 : 0);
  };
  for (const [key, members] of accounts) {
    for (const i of members) accSize[i] = members.length;
    let best = members[0] as number;
    if (members.length > 1) {
      for (const i of members) {
        const a = lights[i] as Light, b = lights[best] as Light;
        const pa = a.kind === 'p' ? 0 : 1, pb = b.kind === 'p' ? 0 : 1;
        if (pa !== pb) { if (pa < pb) best = i; continue; }
        const ca = contactScore(i), cb = contactScore(best);
        if (ca !== cb) { if (ca > cb) best = i; continue; }
        if (a.keyHash < b.keyHash) best = i;
      }
      const types = new Set(members.map((i) => etype[i] as EntityType));
      const hasCompany = types.has(ENTITY_TYPE.PODMIOT_PRAWNY) || types.has(ENTITY_TYPE.PUBLICZNY);
      const hasPractice = types.has(ENTITY_TYPE.PRAKTYKA_IND) || types.has(ENTITY_TYPE.PRAKTYKA_GRUP);
      // the same s.c. / jawna / partnerska registered as podmiot and as group practice is one subject (VAL-5)
      const samePartnership = hasCompany && types.size === 2 && types.has(ENTITY_TYPE.PODMIOT_PRAWNY) && types.has(ENTITY_TYPE.PRAKTYKA_GRUP)
        && members.every((i) => etype[i] !== ENTITY_TYPE.PODMIOT_PRAWNY || PARTNERSHIP_FORMA.test((lights[i] as Light).forma ?? ''));
      if (hasCompany && hasPractice && !samePartnership) accountCheck.add(key);
      // without a company (a JDG with practices, or practices only): ACCOUNT_CHECK when "to różne podmioty" would detach a
      // practice of somebody else, by the same rule as the database (VAL-4, VAL-R4-1, VAL-R5-1, VAL-R5-2, RD2-2)
      else if (!hasCompany && types.has(ENTITY_TYPE.PRAKTYKA_IND)) {
        const detached = detachedPractices(members.map((i) => {
          const l = lights[i] as Light;
          return { ref: i, type: etype[i] as EntityType, name: l.name, profession: professionOf(l.src), licence: licenceOf(l.npwz[0]), primary: i === best };
        }));
        if (detached.length > 0) accountCheck.add(key);
      }
    }
    isPrimary[best] = true;
  }

  /* ---- 3. per-entry contact analysis and the cross-entry maps ---- */
  const stale = new Array<boolean>(n);
  const validEmails = new Array<string[]>(n);
  const nums = new Array<string[]>(n);
  const wwwInfo = new Array<ReturnType<typeof wwwQuality> | null>(n);
  const emailAccounts = new Map<string, Set<string>>();
  const wwwAccounts = new Map<string, Set<string>>();
  const phoneAccounts = new Map<string, Set<string>>();
  const phonePodmiotAccounts = new Map<string, Set<string>>();
  const telOwners = new Map<string, Set<string>>();
  const mobileOwners = new Map<string, Set<string>>();
  const domainStats = new Map<string, { accounts: Set<string>; woj: Set<string> }>();
  // domains of every WWW field in the file: an e-mail domain that is somebody's own website is never a typo (VAL-R3-4)
  const webHosts: string[] = [];
  for (const l of lights) {
    const w = l.www ? wwwQuality(l.www) : null;
    if (w && w.status === 'ok' && w.host) webHosts.push(w.host);
  }
  const webDomains = hostDomains(webHosts);

  for (let i = 0; i < n; i++) {
    const l = lights[i] as Light;
    const ak = accKey[i] as string;
    stale[i] = isStale(l.stan, params.staleBefore);
    const ev: string[] = [];
    for (const raw of l.emails.length ? l.emails : l.email ? [l.email] : []) {
      const e = normalizeEmail(raw);
      if (isValidEmail(e) && !ev.includes(e)) ev.push(e);
    }
    validEmails[i] = ev;
    for (const e of ev) {
      add(emailAccounts, e, ak);
      const dom = emailDomain(e);
      if (classifyDomain(dom, table, webDomains).cls === 'company') {
        let ds = domainStats.get(dom);
        if (!ds) domainStats.set(dom, (ds = { accounts: new Set(), woj: new Set() }));
        ds.accounts.add(ak);
        if (l.woj) ds.woj.add(l.woj);
      }
    }
    const parsed = recordNums(l.tel, l.phones);
    nums[i] = parsed.map((p) => p.n);
    for (const p of parsed) {
      add(phoneAccounts, p.n, ak);
      if (l.kind === 'p') add(phonePodmiotAccounts, p.n, ak);
    }
    const first = parsed[0];
    if (first) add(telOwners, l.kind + first.n, nipKey(nipOwn[i]) ?? '#' + i);
    for (const p of parsed) if (p.cls === 'kom') add(mobileOwners, p.n, nipKey(nipOwn[i]) ?? ak);
    const w = l.www ? wwwQuality(l.www) : null;
    wwwInfo[i] = w;
    if (w && w.status === 'ok' && w.host) add(wwwAccounts, w.host, ak);
  }

  // company domains shared by many accounts across the country are generic, not a network signal
  const autoGeneric: string[] = [];
  for (const [dom, ds] of domainStats) {
    if (ds.accounts.size >= params.genericDomainAccounts && ds.woj.size >= 3) {
      autoGeneric.push(dom);
      if (!table.has(dom)) table.set(dom, { kind: 'generic', suggestion: null });
    }
  }
  autoGeneric.sort();

  /* ---- 4. derived fields ---- */
  const derived = new Array<DerivedFields>(n);
  for (let i = 0; i < n; i++) {
    const l = lights[i] as Light;
    const ev = validEmails[i] as string[];
    const numList = nums[i] as string[];
    const st = nipSt[i] as number;
    const isStaleRec = stale[i] as boolean;
    let flags = 0;
    if (st === NIP_STATUS.NONE) flags |= QFLAG.NIP_MISSING;
    else if (st === NIP_STATUS.BAD_FORMAT) flags |= QFLAG.NIP_BAD_FORMAT;
    else if (st === NIP_STATUS.PLACEHOLDER) flags |= QFLAG.NIP_PLACEHOLDER;
    else if (st === NIP_STATUS.CHECKSUM) flags |= QFLAG.NIP_CHECKSUM;
    if (ev.length === 0 && numList.length === 0) flags |= QFLAG.NO_CONTACT;

    // e-mail: flags from the primary address, score = best valid address
    const primaryRaw = l.email ?? l.emails[0] ?? null;
    if (primaryRaw) {
      const pe = normalizeEmail(primaryRaw);
      if (!isValidEmail(pe)) flags |= QFLAG.EMAIL_INVALID;
      else {
        const cls = classifyDomain(emailDomain(pe), table, webDomains).cls;
        if (cls === 'typo') flags |= QFLAG.EMAIL_TYPO;
        if (cls === 'free') flags |= QFLAG.EMAIL_FREE;
        if (emailRole(pe)) flags |= QFLAG.EMAIL_ROLE;
        if (setSize(emailAccounts, pe) >= 2) flags |= QFLAG.EMAIL_SHARED;
      }
    }
    let qEmail: number | null = null;
    for (const e of ev) {
      const q = emailQuality(e, setSize(emailAccounts, e), isStaleRec, table, webDomains);
      if (qEmail === null || q > qEmail) qEmail = q;
    }

    // phone
    const telNorm = numList[0] ?? null;
    let telShared: number | null = null;
    let qPhone: number | null = null;
    if (telNorm) {
      telShared = setSize(telOwners, l.kind + telNorm);
      qPhone = phoneQuality(phoneClass(telNorm), telShared, isStaleRec);
      if (telShared >= 10) flags |= QFLAG.PHONE_SWITCHBOARD;
      else if (telShared >= 2) flags |= QFLAG.PHONE_SHARED;
    }
    if (l.tel && numList.length === 0) flags |= QFLAG.PHONE_UNPARSEABLE;

    const w = wwwInfo[i];
    if (w) {
      if (w.status === 'invalid') flags |= QFLAG.WWW_INVALID;
      else if (w.status === 'social') flags |= QFLAG.WWW_SOCIAL;
    }
    if (isStaleRec) flags |= QFLAG.STALE;
    if (l.regDup) flags |= QFLAG.REG_DUPLICATE;
    if (etype[i] === ENTITY_TYPE.PRAKTYKA_GRUP && l.nip && !nipOwn[i]) flags |= QFLAG.GROUP_NIP_IS_PARTNER;
    if (l.emailFromWww) flags |= QFLAG.EMAIL_FROM_WWW;
    if (l.status !== 'aktywny' && l.status !== 'active') flags |= QFLAG.INACTIVE;
    if (accountCheck.has(accKey[i] as string)) flags |= QFLAG.ACCOUNT_CHECK;

    // mobile = the first mobile number used by fewer than MOBILE_SHARED_OWNERS owners; a call-centre mobile stays in nums (VAL-R3-6)
    let parsedMobile: string | null = null;
    for (const x of numList) {
      if (phoneClass(x) !== 'kom') continue;
      if (setSize(mobileOwners, x) >= MOBILE_SHARED_OWNERS) flags |= QFLAG.MOBILE_SHARED;
      else if (parsedMobile === null) parsedMobile = x;
    }
    const ft: FormType | null = l.kind === 'p' ? formTypeOf(l.forma) : null;
    // key order is part of the hash contract (DerivedFields)
    derived[i] = {
      nipStatus: st as DerivedFields['nipStatus'],
      entityType: etype[i] as EntityType,
      accountKey: accKey[i] as string,
      accountSize: accSize[i] as number,
      isAccountPrimary: isPrimary[i] as boolean,
      telShared,
      qEmail,
      qPhone,
      qflags: flags,
      mobile: parsedMobile,
      telNorm,
      nums: numList,
      formType: ft,
      spec1: l.kind === 'p' ? spec1Count(l.spec) : null,
    };
  }

  /* ---- 5. proposals (members are account keys) ---- */
  const proposals: ImportProposalRow[] = [];
  const push = (kind: ProposalKind, matchValue: string, confidence: number, members: Iterable<string>) => {
    const m = [...new Set(members)].sort();
    proposals.push({ kind, matchValue, confidence, groupKey: groupKeyOf(m), members: m });
  };

  // account_check: same NIP, a company and a practice
  for (const key of [...accountCheck].sort()) push('account_check', key, 60, [key]);

  // reg_duplicate: entries sharing (src, org, ks)
  const regGroups = new Map<string, string[]>();
  for (let i = 0; i < n; i++) {
    const l = lights[i] as Light;
    if (!l.regDup) continue;
    const g = regGroups.get(l.regGroup);
    if (g) g.push(accKey[i] as string);
    else regGroups.set(l.regGroup, [accKey[i] as string]);
  }
  for (const [g, members] of [...regGroups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) push('reg_duplicate', g, 90, members);

  // person: the same licence number under different accounts. Only a practice's OWN licence counts: a group practice lists
  // its partners' numbers, and those link it to the partners' practices as 'partner', never as 'the same person' (VAL-R2-1).
  const npwzAccounts = new Map<string, Set<string>>();
  const npwzNames = new Map<string, string[][]>();
  const npwzOf = (l: Light, raw: string): string | null => {
    const v = raw.trim();
    return v.length < 4 || /^(.)\1*$/.test(v) ? null : professionOf(l.src) + ':' + v;
  };
  for (let i = 0; i < n; i++) {
    const l = lights[i] as Light;
    for (const raw of l.npwz) {
      const k = npwzOf(l, raw);
      if (!k) continue;
      add(npwzAccounts, k, accKey[i] as string);
      const names = npwzNames.get(k);
      if (names) names.push(foldedTokenList(l.name));
      else npwzNames.set(k, [foldedTokenList(l.name)]);
    }
  }
  // Confidence 90 only when the holders' names nest (one person, middle names / initials allowed, VAL-R3-5) and no member
  // account holds other people's entries (ACCOUNT_CHECK: the database refuses the merge until the account is split,
  // VAL-R3-2); otherwise 55 ("sprawdź": a licence-number typo in the register, or an account to split first).
  for (const [v, set] of [...npwzAccounts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (set.size < 2 || set.size > 20) continue;
    const onePerson = distinctPersons(npwzNames.get(v) ?? []) <= 1;
    const clean = ![...set].some((k) => accountCheck.has(k));
    push('person', 'npwz:' + v, onePerson && clean ? 90 : 55, set);
  }

  // partner: partner NIP equals another account's OK NIP
  const pairs = new Set<string>();
  for (let i = 0; i < n; i++) {
    const l = lights[i] as Light;
    if (l.partnerNips.length === 0) continue;
    const own = accKey[i] as string;
    for (const pn of l.partnerNips) {
      if (nipStatus(pn) !== NIP_STATUS.OK) continue;
      const other = 'n:' + pn;
      if (other !== own && accounts.has(other)) pairs.add(own + '>' + other);
    }
  }
  for (const p of [...pairs].sort()) {
    const [a, b] = p.split('>') as [string, string];
    push('partner', p, 75, [a, b]);
  }
  // partner without a usable NIP: link the group practice to the individual practice that holds the partner's licence
  const partnerLic = new Map<string, Set<string>>();
  for (let i = 0; i < n; i++) {
    const l = lights[i] as Light;
    if (etype[i] !== ENTITY_TYPE.PRAKTYKA_GRUP) continue;
    for (const raw of l.partnerNpwz ?? []) {
      const k = npwzOf(l, raw);
      const targets = k ? npwzAccounts.get(k) : undefined;
      if (!k || !targets) continue;
      for (const t of targets) {
        if (t === accKey[i] || pairs.has((accKey[i] as string) + '>' + t) || pairs.has(t + '>' + (accKey[i] as string))) continue;
        add(partnerLic, k, accKey[i] as string);
        add(partnerLic, k, t);
      }
    }
  }
  for (const [k, set] of [...partnerLic].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (set.size >= 2 && set.size <= 20) push('partner', 'npwz:' + k, 75, set);
  }

  // e-mail clusters
  const emailSets = new Set<string>();
  for (const [e, set] of [...emailAccounts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (set.size >= 2 && set.size <= params.emailClusterMax) {
      push('email', e, set.size <= 5 ? 85 : 70, set);
      emailSets.add(groupKeyOf([...set]));
    }
  }
  // domain clusters (company domains only; an e-mail cluster with the same members is stronger)
  const domainAccounts = new Map<string, Set<string>>();
  for (const [dom, ds] of domainStats) {
    if (table.get(dom)?.kind === 'generic') continue;
    domainAccounts.set(dom, ds.accounts);
  }
  for (const [dom, set] of [...domainAccounts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (set.size < 2 || set.size > params.domainClusterMax) continue;
    if (emailSets.has(groupKeyOf([...set]))) continue;
    push('domain', dom, set.size <= 10 ? 70 : 55, set);
  }
  // www clusters
  const accountTokens = new Map<string, Set<string>>();
  for (let i = 0; i < n; i++) {
    let st = accountTokens.get(accKey[i] as string);
    if (!st) accountTokens.set(accKey[i] as string, (st = new Set()));
    for (const t of nameTokenList((lights[i] as Light).name)) if (t.length >= 4 && !NAME_STOP_WORDS.has(t)) st.add(t);
  }
  const sharesNameToken = (members: Iterable<string>): boolean => {
    const seen = new Set<string>();
    for (const m of members) {
      for (const t of accountTokens.get(m) ?? []) {
        if (seen.has(t)) return true;
        seen.add(t);
      }
    }
    return false;
  };
  for (const [host, set] of [...wwwAccounts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (set.size < 2 || set.size > params.wwwClusterMax) continue;
    const cls = classifyDomain(host, table).cls;
    if (cls === 'generic' || cls === 'free' || cls === 'social') continue;
    // a practitioner listing the clinic's site is not a network: strong only with >= 2 podmiot accounts or a shared name / street
    // token among the members; otherwise below the default minimum confidence (VAL-R2-5)
    const podmiotAcc = new Set<string>();
    for (let i = 0; i < n; i++) if ((lights[i] as Light).kind === 'p' && set.has(accKey[i] as string)) podmiotAcc.add(accKey[i] as string);
    const strong = podmiotAcc.size >= 2 || sharesNameToken(set);
    push('www', host, strong ? (set.size <= 10 ? 80 : 65) : 45, set);
  }
  // phone clusters: at least two podmiot accounts share the number (a practitioner listing the clinic's phone where
  // they work is not a network), at most phoneClusterMax accounts (VAL-2)
  for (const [num, set] of [...phoneAccounts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (set.size <= params.phoneClusterMax && (phonePodmiotAccounts.get(num)?.size ?? 0) >= 2) push('phone', num, 60, set);
  }

  return { derived, proposals, autoGenericDomains: autoGeneric };
}

/** Kinds of proposal in the "Konta" queue vs the "Sieci i duplikaty" queue (CONTRACT 5, `val_queue`). */
export const ACCOUNT_KINDS: readonly ProposalKind[] = ['account_check', 'person', 'reg_duplicate'];
export const NETWORK_KINDS: readonly ProposalKind[] = ['email', 'domain', 'www', 'phone', 'partner'];

export function sourceIndex(src: string): number {
  return (SOURCES as readonly string[]).indexOf(src);
}
