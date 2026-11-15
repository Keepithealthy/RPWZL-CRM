/**
 * Round-3 validation fixes (VAL-R3-1 .. VAL-R3-9), synthetic data only. The seed rows of `generic_domain` are read from the
 * migration so the worker's DomainTable here is the one a fresh database gives it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTITY_TYPE, NIP_STATUS, QFLAG, type ValDecisions } from '../../lib/contract';
import { deriveAll, detachedPractices, licenceOf, MOBILE_SHARED_OWNERS, personTokens, samePersonTokens, type AccountEntry, type Light } from './derive';
import { classifyDomain, entityType, hostDomains, nipKey, nipStatus, wwwQuality, type DomainTable } from './rules';

/** Rows of `insert into crm.generic_domain` in the core migration: the free / social `unnest(array[...])` lists and the tuples. */
function seedRows(): Array<{ domain: string; kind: 'free' | 'generic' | 'typo' | 'social'; suggestion: string | null }> {
  const rel = 'supabase/migrations/20261115100100_core_tables.sql';
  const file = [resolve(process.cwd(), '..', rel), resolve(process.cwd(), rel)].find((f) => existsSync(f));
  if (!file) throw new Error('core migration not found from ' + process.cwd());
  const sql = readFileSync(file, 'utf8');
  const out: Array<{ domain: string; kind: 'free' | 'generic' | 'typo' | 'social'; suggestion: string | null }> = [];
  for (const m of sql.matchAll(/insert into crm\.generic_domain \(domain, kind\) select d, '(free|social)' from unnest\(array\[([\s\S]*?)\]\) as d;/g)) {
    for (const d of (m[2] as string).matchAll(/'([^']+)'/g)) out.push({ domain: d[1] as string, kind: m[1] as 'free' | 'social', suggestion: null });
  }
  for (const m of sql.matchAll(/insert into crm\.generic_domain \(domain, kind(?:, suggestion)?\) values([\s\S]*?);/g)) {
    for (const t of (m[1] as string).matchAll(/\('([^']+)','(generic|typo)'(?:,(?:'([^']+)'|null))?\)/g)) {
      out.push({ domain: t[1] as string, kind: t[2] as 'generic' | 'typo', suggestion: t[3] ?? null });
    }
  }
  return out;
}
const SEED = seedRows();
const seedTable: DomainTable = new Map(SEED.map((r) => [r.domain, { kind: r.kind, suggestion: r.suggestion }]));
const seedDecisions: ValDecisions = { detach: [], attach: [], genericDomains: SEED, decidedProposals: [], params: {} as ValDecisions['params'] };

function nip(nine0: number): string {
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  for (let n = nine0 * 20 + 523_456_789; ; n++) {
    const s = String(n);
    const c = s.split('').reduce((a, d, i) => a + Number(d) * (w[i] as number), 0) % 11;
    if (c !== 10) return s + String(c);
  }
}
let seq = 0;
function light(o: Partial<Light>): Light {
  seq++;
  return {
    kind: 'r', src: 'Rpz', keyHash: (0x7000 + seq).toString(16).padStart(16, '0'), regGroup: 'g' + seq, regDup: false, name: 'Test ' + seq,
    nip: null, forma: null, typ: null, status: 'aktywny', stan: '2025-01-01', woj: 'mazowieckie', email: null, emails: [],
    tel: null, phones: [], www: null, partnerNips: [], npwz: [], spec: [], ...o,
  };
}

describe('VAL-R3-1 public suffixes never hide companies', () => {
  it('the seed table has the suffix rows removed and keeps the real generic rows', () => {
    expect(SEED.length).toBeGreaterThan(150);
    for (const d of ['com.pl', 'net.pl', 'edu.pl', 'lm.pl']) expect(seedTable.get(d)?.kind, d).not.toBe('generic');
    expect(seedTable.get('gov.pl')?.kind).toBe('generic');
  });
  it('companies under .com.pl / .edu.pl / .net.pl are company domains with the seed table', () => {
    for (const d of ['alab.com.pl', 'scs.com.pl', 'dscm.com.pl', 'uczelnia-test.edu.pl', 'medikon.net.pl', 'visum.net.pl']) {
      expect(classifyDomain(d, seedTable).cls, d).toBe('company');
    }
    expect(classifyDomain('sanepid.gov.pl', seedTable).cls).toBe('generic');
  });
  it('even an owner row for a public suffix matches only that exact domain', () => {
    const t: DomainTable = new Map([...seedTable, ['com.pl', { kind: 'generic', suggestion: null }]]);
    expect(classifyDomain('alab.com.pl', t).cls).toBe('company');
    expect(classifyDomain('com.pl', t).cls).toBe('generic');
  });
  it('a domain network under .com.pl produces a domain proposal again', () => {
    const a = light({ kind: 'p', src: 'Rpm', forma: 'spółka z ograniczoną odpowiedzialnością', nip: nip(1), emails: ['jan@alab-test.com.pl'] });
    const b = light({ kind: 'p', src: 'Rpm', forma: 'spółka z ograniczoną odpowiedzialnością', nip: nip(2), emails: ['ola@alab-test.com.pl'] });
    const { proposals } = deriveAll([a, b], seedDecisions);
    expect(proposals.some((p) => p.kind === 'domain' && p.matchValue === 'alab-test.com.pl')).toBe(true);
  });
});

describe('VAL-R3-4 typo rules', () => {
  it('02.pl suggests o2.pl, other 1-2 character names have no suggestion', () => {
    expect(classifyDomain('02.pl')).toEqual({ cls: 'typo', suggestion: 'o2.pl' });
    expect(classifyDomain('02.pl', seedTable)).toEqual({ cls: 'typo', suggestion: 'o2.pl' });
    for (const d of ['kn.pl', 'sw.pl', 't.pl']) expect(classifyDomain(d), d).toEqual({ cls: 'typo', suggestion: null });
  });
  it("a domain that is somebody's own website is never a rule-derived typo", () => {
    expect(classifyDomain('cos.pl').cls).toBe('typo');
    expect(classifyDomain('cos.pl', undefined, hostDomains(['cos.pl'])).cls).toBe('company');
    expect(classifyDomain('wpr.pl', undefined, hostDomains(['rejestracja.wpr.pl'])).cls).toBe('company');
    // a listed typo stays a typo
    expect(classifyDomain('gmial.com', undefined, hostDomains(['gmial.com'])).cls).toBe('typo');
  });
  it('the worker passes the WWW hosts of the file into the e-mail flags', () => {
    const a = light({ kind: 'p', src: 'Rpm', forma: 'samodzielny publiczny zakład opieki zdrowotnej', nip: nip(3), emails: ['sekretariat@cos.pl'], www: 'www.cos.pl' });
    const { derived } = deriveAll([a], seedDecisions);
    expect(derived[0]!.qflags & QFLAG.EMAIL_TYPO).toBe(0);
    expect(derived[0]!.qEmail).toBeGreaterThan(10);
  });
});

describe('VAL-R3-7 ISP and portal lists', () => {
  it('lists the ISPs as free (with sub-domains) and the NFZ branches as generic', () => {
    for (const d of ['toya.net.pl', 'ape.net.pl', 'creator.wroc.pl', 'gryf.info.pl', 'amorki.pl', 'mail.pl', 'x.opoka.org.pl', 'tpnet.pl']) {
      expect(classifyDomain(d, seedTable).cls, d).toBe('free');
      expect(classifyDomain(d).cls, d).toBe('free');
    }
    for (const d of ['nfz-rzeszow.pl', 'nfz-krakow.pl', 'teb-edukacja.pl']) {
      expect(classifyDomain(d, seedTable).cls, d).toBe('generic');
      expect(classifyDomain(d).cls, d).toBe('generic');
    }
  });
});

describe('VAL-R3-9 zero-padded NIPs', () => {
  it('a NIP starting with 0 is a placeholder even with a valid checksum, and never an owner key', () => {
    expect(nipStatus('0000000508')).toBe(NIP_STATUS.PLACEHOLDER);
    expect(nipKey('0000000508')).toBeNull();
    const l = light({ nip: '0000000508' });
    expect(deriveAll([l], null).derived[0]!.accountKey).toBe('e:' + l.keyHash);
  });
});

describe('VAL-R3-6 shared mobiles', () => {
  it(`a mobile listed by ${MOBILE_SHARED_OWNERS} or more owners stays in nums but is not 'mobile' and is flagged`, () => {
    const callCentre = '500 100 200';
    const many = Array.from({ length: MOBILE_SHARED_OWNERS }, (_, i) => light({ nip: nip(100 + i), tel: callCentre, phones: i === 0 ? ['601 222 333'] : [] }));
    const { derived } = deriveAll(many, null);
    expect(derived[0]!.nums).toEqual(['500100200', '601222333']);
    expect(derived[0]!.mobile).toBe('601222333');
    expect(derived[0]!.qflags & QFLAG.MOBILE_SHARED).toBeTruthy();
    expect(derived[1]!.mobile).toBeNull();
    expect(derived[1]!.nums).toEqual(['500100200']);
  });
  it('a mobile of fewer owners is kept', () => {
    const few = Array.from({ length: MOBILE_SHARED_OWNERS - 1 }, (_, i) => light({ nip: nip(200 + i), tel: '500 300 400' }));
    const { derived } = deriveAll(few, null);
    expect(derived.every((d) => d.mobile === '500300400' && (d.qflags & QFLAG.MOBILE_SHARED) === 0)).toBe(true);
  });
});

describe('VAL-R3-2 / VAL-R3-5 person proposals', () => {
  it('names that nest give confidence 90', () => {
    const a = light({ name: 'Anna Maria Testowa-Śliwińska', npwz: ['4455667'] });
    const b = light({ name: 'A. Testowa-Sliwinska', npwz: ['4455667'], nip: nip(300) });
    const p = deriveAll([a, b], null).proposals.find((x) => x.kind === 'person');
    expect(p?.confidence).toBe(90);
  });
  it('different people with one licence number get 55', () => {
    const a = light({ name: 'Barbara Przykładowa', npwz: ['5566778'] });
    const b = light({ name: 'Marek Ezel', npwz: ['5566778'], nip: nip(301) });
    const p = deriveAll([a, b], null).proposals.find((x) => x.kind === 'person');
    expect(p?.confidence).toBe(55);
  });
  it('a member account that needs an account check gives 55', () => {
    const hosp = nip(302);
    const h = light({ kind: 'p', src: 'Rpm', forma: 'samodzielny publiczny zakład opieki zdrowotnej', nip: hosp, name: 'Szpital Testowy' });
    const d1 = light({ name: 'Jan Test', npwz: ['6677889'], nip: hosp });
    const d2 = light({ name: 'Jan Test', npwz: ['6677889'], nip: nip(303) });
    const { proposals } = deriveAll([h, d1, d2], null);
    expect(proposals.some((x) => x.kind === 'account_check')).toBe(true);
    expect(proposals.find((x) => x.kind === 'person')?.confidence).toBe(55);
  });
});

describe('VAL-R3-8 podmioty without a legal form', () => {
  it('a name that nests with a same-NIP practice makes the podmiot a JDG, so no account check', () => {
    const n = nip(400);
    const p = light({ kind: 'p', src: 'Rpm', forma: null, nip: n, name: 'Jan Śmiały' });
    const r = light({ name: 'Jan Adam Smiały', nip: n, npwz: ['7788990'] });
    const { derived } = deriveAll([p, r], null);
    expect(derived[0]!.entityType).toBe(ENTITY_TYPE.JDG);
    expect(derived[0]!.qflags & QFLAG.ACCOUNT_CHECK).toBe(0);
  });
  it("a name starting with 'osoba fizyczna' is a JDG", () => {
    expect(entityType({ kind: 'p', src: 'Rpm', forma: null, name: 'Osoba fizyczna: Jan Test' })).toBe(ENTITY_TYPE.JDG);
  });
});

describe('VAL-R4-3 public suffixes, portals and universities', () => {
  it('a WWW host never makes a public suffix "somebody\'s website"', () => {
    const web = hostDomains(['firma-testowa.com.pl', 'rejestracja.przychodnia-testowa.waw.pl']);
    expect(web.has('firma-testowa.com.pl')).toBe(true);
    for (const d of ['com.pl', 'waw.pl', 'pl']) expect(web.has(d), d).toBe(false);
    expect(classifyDomain('com.pl', undefined, web)).toEqual({ cls: 'typo', suggestion: null });
  });
  it('bare public suffixes are typos, with and without the seed table; companies under them stay companies', () => {
    for (const d of ['com.pl', 'net.pl', 'org.pl', 'edu.pl', 'waw.pl']) {
      expect(classifyDomain(d).cls, d).toBe('typo');
      expect(classifyDomain(d, seedTable)).toEqual({ cls: 'typo', suggestion: null });
    }
    expect(classifyDomain('alab-test.com.pl', seedTable).cls).toBe('company');
    expect(classifyDomain('poczta.net.pl', seedTable)).toEqual({ cls: 'typo', suggestion: 'onet.pl' });
  });
  it('city / ISP portals are free, medical universities generic (with sub-domains), a path-identity portal social', () => {
    for (const d of ['elblag.com.pl', 'sanok.com.pl', 'grudziadz.com.pl', 'tenit.com.pl', 'sanatoria.com.pl', 'x.tenit.com.pl']) {
      expect(classifyDomain(d, seedTable).cls, d).toBe('free');
      expect(classifyDomain(d).cls, d).toBe('free');
    }
    for (const d of ['gumed.edu.pl', 'ump.edu.pl', 'umb.edu.pl', 'wydzial.ump.edu.pl']) {
      expect(classifyDomain(d, seedTable).cls, d).toBe('generic');
      expect(classifyDomain(d).cls, d).toBe('generic');
    }
    expect(wwwQuality('http://www.medycyna.net.pl/testowa/').status).toBe('social');
    expect(classifyDomain('medycyna.net.pl', seedTable).cls).toBe('social');
  });
  it('an e-mail at a bare suffix gives no domain proposal and is flagged as a typo', () => {
    const a = light({ kind: 'p', src: 'Rpm', forma: 'spółka z ograniczoną odpowiedzialnością', nip: nip(400), emails: ['jan@com.pl'], www: 'firma-a.com.pl' });
    const b = light({ kind: 'p', src: 'Rpm', forma: 'spółka z ograniczoną odpowiedzialnością', nip: nip(401), emails: ['ola@com.pl'], www: 'firma-b.com.pl' });
    const { derived, proposals } = deriveAll([a, b], seedDecisions);
    expect(proposals.some((p) => p.kind === 'domain' && p.matchValue === 'com.pl')).toBe(false);
    expect(derived[0]!.qflags & QFLAG.EMAIL_TYPO).toBeTruthy();
  });
  it('university staff addresses give no domain proposal', () => {
    const a = light({ kind: 'p', src: 'Rpm', forma: 'spółka z ograniczoną odpowiedzialnością', nip: nip(402), emails: ['a.testowa@gumed.edu.pl'] });
    const b = light({ src: 'Rpz', nip: nip(403), name: 'Ola Testowa', email: 'o.testowa@gumed.edu.pl', emails: ['o.testowa@gumed.edu.pl'] });
    expect(deriveAll([a, b], seedDecisions).proposals.some((p) => p.kind === 'domain')).toBe(false);
  });
});

describe('VAL-R4-1 / VAL-R4-4 a JDG with another person\'s practice', () => {
  it('samePersonTokens: nesting, or the first name of one among the tokens of the other (VAL-R5-1, VAL-R5-2)', () => {
    const t = (s: string) => personTokens(s);
    expect(samePersonTokens(t('Jan Testowy'), t('Gabinet Lekarski Jan Maria Testowy'))).toBe(true);
    expect(samePersonTokens(t('Iga Paulina Testowa-Przykładowa'), t('Iga Testowa - Przykładowa'))).toBe(true);
    expect(samePersonTokens(t('Fizjoterapia Testowy'), t('Jan Testowy'))).toBe(false);
    expect(samePersonTokens(t('Robert Test'), t('Urszula Test'))).toBe(false);
    expect(samePersonTokens(t('R. Test'), t('U. Test'))).toBe(false);
    expect(samePersonTokens(t('Osoba fizyczna: Ewa Testowa Próbna'), t('Ewa Zofia Przykładowa'))).toBe(true);
    expect(samePersonTokens(t('Fizjoterapia Anna Testowa'), t('Anna Maria Przykładowa'))).toBe(true);
    expect(samePersonTokens(t('Usługi Radiologiczne Ewa Testowa'), t('Grażyna Przykładowa'))).toBe(false);
    expect(samePersonTokens(t('Iga Testowa - Przykładowa'), t('Dawid Łukasz Przykładowy'))).toBe(false);
    expect(samePersonTokens(t('Medicus'), t('Jan Testowy'))).toBe(false);
  });
  it('folds Latin Extended letters like SQL private.name_tokens (VAL-R5-5)', () => {
    expect(personTokens('Tešťák Přykładová-Çestowa')).toEqual(['testak', 'prykladova', 'cestowa']);
    expect(personTokens('Łucja Øtest Testße')).toEqual(['lucja', 'otest', 'testsse']);
    expect(samePersonTokens(personTokens('Ola Teśťová'), personTokens('Ola Testova'))).toBe(true);
  });
  it('licenceOf drops placeholders; detachedPractices is the twin of SQL private.minority_entries', () => {
    expect(licenceOf(' 0000000 ')).toBeNull();
    expect(licenceOf(' 1234567 ')).toBe('1234567');
    const e = (ref: number, name: string, o: Partial<AccountEntry> = {}): AccountEntry =>
      ({ ref, type: ENTITY_TYPE.PRAKTYKA_IND, name, profession: 'lek', licence: String(5550000 + ref), primary: false, ...o });
    // a family on one NIP: the other first name is split out, the primary's own second profession stays (VAL-R5-2)
    expect(detachedPractices([e(1, 'Robert Test', { primary: true }), e(2, 'Urszula Test', { profession: 'piel' }),
      e(3, 'Robert Adam Test', { profession: 'piel' })])).toEqual([2]);
    // another doctor is the primary: the person's practice is split out (RD2-1)
    expect(detachedPractices([e(1, 'Olga Inna', { primary: true }), e(2, 'Piotr Testowy')])).toEqual([2]);
    // one name with two numbers of one register (doctor and dentist) is one person: nothing to split
    expect(detachedPractices([e(1, 'Olga Testowa', { primary: true }), e(2, 'Olga Testowa')])).toEqual([]);
    // the same licence is the same person whatever the name (an initial instead of the first name)
    expect(detachedPractices([e(1, 'Olga Inna', { primary: true }), e(2, 'O. Testowa', { licence: '5550001' })])).toEqual([]);
    // a JDG with its owner's practice under a changed surname: nothing to split (VAL-R5-1)
    expect(detachedPractices([e(1, 'Fizjoterapia Anna Testowa', { type: ENTITY_TYPE.JDG, licence: null }), e(2, 'Anna Maria Przykładowa')])).toEqual([]);
    // a JDG, its owner's practice and the practice of somebody with another first name: that one is split
    expect(detachedPractices([e(1, 'Osoba fizyczna: Ewa Testowa Próbna', { type: ENTITY_TYPE.JDG, licence: null }), e(2, 'Ewa Testowa'),
      e(3, 'Zofia Przykładowa')])).toEqual([3]);
    // VAL-R6-1: two practices of one profession with different valid licence numbers and a shared first name are two people
    expect(detachedPractices([e(1, 'Anna Testowa', { primary: true }), e(2, 'Anna Próbna')])).toEqual([2]);
    expect(detachedPractices([e(1, 'M. J. K.', { primary: true }), e(2, 'M. D. K.')])).toEqual([2]);
    // ... unless a licence is missing, or the professions differ: the first-name branch stays
    expect(detachedPractices([e(1, 'Anna Testowa', { primary: true }), e(2, 'Anna Próbna', { licence: null })])).toEqual([]);
    expect(detachedPractices([e(1, 'Anna Testowa', { primary: true }), e(2, 'Anna Próbna', { profession: 'piel' })])).toEqual([]);
    // a JDG against a practice keeps the first-name branch
    expect(detachedPractices([e(1, 'Fizjoterapia Anna Testowa', { type: ENTITY_TYPE.JDG, licence: null }), e(2, 'Anna Próbna')])).toEqual([]);
    expect(samePersonTokens(personTokens('Anna Testowa'), personTokens('Anna Próbna'))).toBe(true);
    expect(samePersonTokens(personTokens('Anna Testowa'), personTokens('Anna Próbna'), true)).toBe(false);
    expect(samePersonTokens(personTokens('Anna Testowa'), personTokens('Anna Maria Testowa'), true)).toBe(true);
  });
  const jdg = (name: string, n: string) => light({ kind: 'p', src: 'Rpm', forma: 'działalność gospodarcza prowadzona przez osobę fizyczną', name, nip: n });
  it('another person\'s practice under a JDG\'s NIP needs an account check, and the person proposal drops to 55', () => {
    const x = jdg('Usługi Radiologiczne Ewa Testowa', nip(410));
    const yAtX = light({ src: 'Rpz', nip: nip(410), name: 'Grażyna Przykładowa', npwz: ['3344556'] });
    const yOwn = light({ src: 'Rpz', nip: nip(411), name: 'Grażyna Przykładowa', npwz: ['3344556'] });
    const { derived, proposals } = deriveAll([x, yAtX, yOwn], null);
    expect(proposals.some((p) => p.kind === 'account_check' && p.matchValue === 'n:' + nip(410))).toBe(true);
    expect(derived[0]!.qflags & QFLAG.ACCOUNT_CHECK).toBeTruthy();
    expect(proposals.find((p) => p.kind === 'person')?.confidence).toBe(55);
  });
  it("an 'osoba fizyczna' JDG with somebody else's practice is checked again (VAL-R4-4)", () => {
    const x = light({ kind: 'p', src: 'Rpm', forma: null, name: 'Osoba fizyczna: Ewa Testowa Próbna', nip: nip(412) });
    const own = light({ src: 'Rpz', nip: nip(412), name: 'Ewa Testowa', npwz: ['3344560'] });
    const y = light({ src: 'Rpz', nip: nip(412), name: 'Zofia Przykładowa', npwz: ['3344557'] });
    const { derived, proposals } = deriveAll([x, own, y], null);
    expect(derived[0]!.entityType).toBe(ENTITY_TYPE.JDG);
    expect(proposals.some((p) => p.kind === 'account_check')).toBe(true);
  });
  it('a JDG with its owner\'s practice under a changed surname is not checked (VAL-R5-1)', () => {
    const x = jdg('Fizjoterapia Anna Testowa', nip(414));
    const y = light({ src: 'Rpf', nip: nip(414), name: 'Anna Maria Przykładowa', npwz: ['3344561'] });
    const { derived, proposals } = deriveAll([x, y], null);
    expect(proposals.some((p) => p.kind === 'account_check')).toBe(false);
    expect(derived.every((d) => (d.qflags & QFLAG.ACCOUNT_CHECK) === 0)).toBe(true);
  });
  it('practices of a family (one surname, other first names) on one NIP are checked (VAL-R5-2)', () => {
    const a = light({ src: 'Rpz', nip: nip(415), name: 'Robert Test', npwz: ['3344562'] });
    const b = light({ src: 'Rpzp', nip: nip(415), name: 'Urszula Test', npwz: ['3344563'] });
    expect(deriveAll([a, b], null).proposals.some((p) => p.kind === 'account_check')).toBe(true);
  });
  it("the JDG owner's own practices are linked without review", () => {
    const x = jdg('Gabinet Lekarski Jan Maria Testowy', nip(413));
    const own = light({ src: 'Rpz', nip: nip(413), name: 'Jan Testowy', npwz: ['3344558'] });
    const own2 = light({ src: 'Rpzp', nip: nip(413), name: 'Jan Maria Testowy', npwz: ['3344559'] });
    const { derived, proposals } = deriveAll([x, own, own2], null);
    expect(proposals.some((p) => p.kind === 'account_check')).toBe(false);
    expect(derived.every((d) => (d.qflags & QFLAG.ACCOUNT_CHECK) === 0)).toBe(true);
  });
});

describe('round 3: domain rules (VAL-R5-3, VAL-R5-4, RD2-5)', () => {
  it('a city suffix is a company domain (Sopot schools), the generic bare suffixes stay typos; TS = seed', () => {
    for (const d of ['sopot.pl', 'krakow.pl', 'olsztyn.pl']) {
      expect(classifyDomain(d).cls, d).toBe('company');
      expect(classifyDomain(d, seedTable).cls, d).toBe('company');
    }
    for (const d of ['com.pl', 'net.pl', 'org.pl', 'edu.pl', 'waw.pl']) expect(classifyDomain(d).cls, d).toBe('typo');
  });
  it('iq.pl is a free ISP mailbox; 3 character near misses get a suggestion only towards wp / o2 / op / vp', () => {
    expect(classifyDomain('iq.pl').cls).toBe('free');
    expect(classifyDomain('iq.pl', seedTable).cls).toBe('free');
    expect(classifyDomain('wpl.pl')).toEqual({ cls: 'typo', suggestion: 'wp.pl' });
    for (const d of ['kos.pl', 'kol.pl', '2gb.pl']) expect(classifyDomain(d), d).toEqual({ cls: 'typo', suggestion: null });
  });
  it('a business.site sub-domain is a social host, as e-mail domain and as WWW (no Customer.io website)', () => {
    expect(classifyDomain('gabinet-testowy.business.site').cls).toBe('social');
    expect(wwwQuality('https://gabinet-testowy.business.site/').status).toBe('social');
    expect(wwwQuality('http://sanatorium.webd.pl').status).toBe('social');
    expect(wwwQuality('gabinet-testowy.pl').status).toBe('ok');
  });
});
