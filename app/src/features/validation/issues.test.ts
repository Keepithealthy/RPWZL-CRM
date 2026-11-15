import { describe, expect, it } from 'vitest';
import { ENTITY_TYPE, QFLAG } from '../../lib/contract';
import { emailFromWww } from '../import/map';
import type { PNorm, RNorm } from '../import/parse';
import { deriveAll, type Light } from './derive';
import { classifyDomain, entityType, wwwQuality } from './rules';

/** Valid synthetic NIP: first nine digits, last digit = checksum. */
function nip(nine0: number): string {
  const nine = nine0 + 123_456_789;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  for (let n = nine; ; n++) {
    const s = String(n);
    const c = s.split('').reduce((a, d, i) => a + Number(d) * (w[i] as number), 0) % 11;
    if (c !== 10 && !/^(\d)\1*$/.test(s + String(c))) return s + String(c);
  }
}

let seq = 0;
function light(o: Partial<Light>): Light {
  seq++;
  return {
    kind: 'r', src: 'Rpzp', keyHash: seq.toString(16).padStart(16, '0'), regGroup: 'g' + seq, regDup: false, name: 'Test ' + seq,
    nip: null, forma: null, typ: null, status: 'aktywny', stan: '2025-01-01', woj: 'mazowieckie', email: null, emails: [],
    tel: null, phones: [], www: null, partnerNips: [], npwz: [], spec: [], ...o,
  };
}
const PODMIOT = { kind: 'p' as const, src: 'Rpm' as const, forma: 'spółka z ograniczoną odpowiedzialnością' };

describe('VAL-1 group practice with a partner NIP', () => {
  it('does not link the practice to the partner account and keeps the flag', () => {
    const partnerNip = nip(111111111);
    const ind = light({ src: 'Rpz', nip: partnerNip, npwz: ['111111'] });
    const grp = light({ src: 'Rpzg', typ: 'grupowa', nip: partnerNip, partnerNips: [partnerNip], npwz: [], partnerNpwz: ['111111'] });
    const { derived } = deriveAll([ind, grp], null);
    expect(derived[1]!.entityType).toBe(ENTITY_TYPE.PRAKTYKA_GRUP);
    expect(derived[1]!.accountKey).toBe('e:' + grp.keyHash);
    expect(derived[1]!.isAccountPrimary).toBe(true);
    expect(derived[1]!.qflags & QFLAG.GROUP_NIP_IS_PARTNER).toBeTruthy();
    expect(derived[0]!.accountKey).toBe('n:' + partnerNip);
    expect(derived[0]!.accountSize).toBe(1);
  });
});

describe('VAL-2 phone proposals', () => {
  it('needs two podmiot accounts', () => {
    const a = light({ ...PODMIOT, nip: nip(222222222), tel: '22 555 01 01' });
    const pr = light({ nip: nip(222222223), tel: '22 555 01 01' });
    expect(deriveAll([a, pr], null).proposals.filter((x) => x.kind === 'phone')).toHaveLength(0);
    const b = light({ ...PODMIOT, nip: nip(222222224), tel: '22 555 01 01' });
    const ph = deriveAll([a, pr, b], null).proposals.filter((x) => x.kind === 'phone');
    expect(ph).toHaveLength(1);
    expect(ph[0]!.confidence).toBe(60);
  });
});

describe('VAL-3 licence numbers are namespaced by profession', () => {
  it('does not pair a physiotherapist with a lab diagnostician', () => {
    const f = light({ src: 'Rpf', nip: nip(333333331), npwz: ['12345'] });
    const d = light({ src: 'Rpdl', nip: nip(333333332), npwz: ['12345'] });
    expect(deriveAll([f, d], null).proposals.filter((x) => x.kind === 'person')).toHaveLength(0);
    const f2 = light({ src: 'Rpf', nip: nip(333333333), npwz: ['12345'] });
    const p = deriveAll([f, d, f2], null).proposals.filter((x) => x.kind === 'person');
    expect(p).toHaveLength(1);
    expect(p[0]!.matchValue).toBe('npwz:fizjo:12345');
  });
});

describe('VAL-4 / VAL-5 account checks', () => {
  it('flags individual practices of different people under one NIP', () => {
    const n = nip(444444444);
    const a = light({ src: 'Rpzp', nip: n, name: 'Anna Próbna', npwz: ['1111111'] });
    const b = light({ src: 'Rpzp', nip: n, name: 'Maria Próbna', npwz: ['2222222'] });
    const { derived, proposals } = deriveAll([a, b], null);
    expect(derived[0]!.qflags & QFLAG.ACCOUNT_CHECK).toBeTruthy();
    expect(proposals.filter((x) => x.kind === 'account_check')).toHaveLength(1);
  });
  it('does not flag one person with two licences', () => {
    const n = nip(444444450);
    const a = light({ src: 'Rpz', nip: n, name: 'Anna Próbna', npwz: ['1111111'] });
    const b = light({ src: 'Rpzp', nip: n, name: 'Próbna Anna', npwz: ['2222222'] });
    expect(deriveAll([a, b], null).derived[0]!.qflags & QFLAG.ACCOUNT_CHECK).toBe(0);
  });
  it('does not flag a spółka cywilna registered as podmiot and as group practice', () => {
    const n = nip(555555555);
    const p = light({ kind: 'p', src: 'Rpm', forma: 'spółka cywilna', nip: n });
    const g = light({ src: 'Rpzg', typ: 'grupowa', nip: n, partnerNips: [] });
    expect(deriveAll([p, g], null).derived[0]!.qflags & QFLAG.ACCOUNT_CHECK).toBe(0);
  });
  it('still flags an sp. z o.o. with a practitioner', () => {
    const n = nip(555555560);
    const p = light({ ...PODMIOT, nip: n });
    const r = light({ src: 'Rpz', nip: n });
    expect(deriveAll([p, r], null).derived[0]!.qflags & QFLAG.ACCOUNT_CHECK).toBeTruthy();
  });
});

describe('VAL-6 / VAL-7 domain lists', () => {
  it('knows the free, generic and social hosts that caused false clusters', () => {
    for (const d of ['aol.com', 'esculap.pl', 'pocztaplus.pl', 'ka.onet.pl', 'poczta.interia.pl']) expect(classifyDomain(d).cls).toBe('free');
    for (const d of ['webmedia.com.pl', 'bitserwis.pl', 'psse-lublin.pl']) expect(classifyDomain(d).cls).toBe('generic');
    for (const d of ['sites.google.com', 'osoz.pl', 'linktr.ee']) expect(classifyDomain(d).cls).toBe('social');
  });
  it('does not treat short real ISP domains as typos but catches the listed typos', () => {
    for (const d of ['inet.pl', 'klinika-abc.pl', 'tvn.pl', 'poczta.firma.pl']) expect(classifyDomain(d).cls).toBe('company');
    for (const d of ['pnet.pl', 'os.pl', 'oz.pl', 'mail.com', 'ymail.com', 'mail.ru', 'x.onet.pl']) expect(classifyDomain(d).cls).toBe('free');
    // VAL-R3-7: ISPs under .net.pl / .lm.pl are listed as free; the suffixes themselves are no longer generic
    for (const d of ['ak.net.pl', 'konin.lm.pl']) expect(classifyDomain(d).cls).toBe('free');
    expect(classifyDomain('lzlrp.pl').cls).toBe('generic');
    expect(classifyDomain('gmail.com.pl')).toEqual({ cls: 'typo', suggestion: 'gmail.com' });
    expect(classifyDomain('interia.com').cls).toBe('typo');
    expect(classifyDomain('onet.poczta.pl')).toEqual({ cls: 'typo', suggestion: 'poczta.onet.pl' });
    expect(classifyDomain('gemail.com').cls).toBe('typo');
    expect(classifyDomain('gmaill.com').cls).toBe('typo');
    expect(classifyDomain('oent.pl').cls).toBe('typo');
    // VAL-R2-4: derived typos
    for (const d of ['poczya.onet.pl', 'poczt.onet.pl', 'poczat.onet.pl', 'pocvzta.onet.pl', 'poczta.wpl.pl', 'poczta.gm', 'poczta.fml', 'wp.plo',
      'wp.pll', 'wp.pi', 'op.pll', 'xlwp.pl', 'wwp.pl', 'oo2.pl', 'protnmail.com', 'zoz.gmail.com', 'wp.gmail.com', 'poczta.gmail.com',
      'e.pl', 'g.pl', 'wo.pl', 'wpl.pl', 'tlan.pl']) expect(classifyDomain(d).cls, d).toBe('typo');
    expect(classifyDomain('sanatorium.webd.pl').cls).toBe('social');
  });
});

describe('VAL-8 e-mail typed into WWW', () => {
  it('is used as the practice e-mail and marked', () => {
    expect(wwwQuality('Jan.Test@gmail.com').email).toBe('jan.test@gmail.com');
    expect(wwwQuality('ul. Testowa 5 m. 3').reason).toBe('adres w polu WWW');
    expect(wwwQuality('Testowa 12, 00-001 Warszawa').reason).toBe('adres w polu WWW');
    const rec = { k: 'r', email: null, www: 'mailto:Gab@wp.pl' } as unknown as RNorm;
    expect(emailFromWww(rec)).toBe('gab@wp.pl');
    expect(emailFromWww({ ...rec, email: 'x@wp.pl' } as RNorm)).toBeNull();
    expect(emailFromWww({ k: 'p', email: null, www: 'a@wp.pl' } as unknown as PNorm)).toBeNull();
    const l = light({ emails: ['gab@wp.pl'], emailFromWww: true, www: 'gab@wp.pl' });
    const d = deriveAll([l], null).derived[0]!;
    expect(d.qflags & QFLAG.EMAIL_FROM_WWW).toBeTruthy();
    expect(d.qflags & QFLAG.NO_CONTACT).toBe(0);
    expect(d.qEmail).not.toBeNull();
  });
});

describe('VAL-9 podmiot without a legal form', () => {
  it('infers the type from the name', () => {
    expect(entityType({ kind: 'p', src: 'Rpm', forma: null, name: 'Publiczny Zakład Opieki Zdrowotnej w X' })).toBe(ENTITY_TYPE.PUBLICZNY);
    expect(entityType({ kind: 'p', src: 'Rpm', forma: null, name: 'Firma sp. z o.o.' })).toBe(ENTITY_TYPE.PODMIOT_PRAWNY);
  });
  it('treats a no-form podmiot with the NIP and name of a practice as a sole trader (no account check)', () => {
    const n = nip(666666666);
    const p = light({ kind: 'p', src: 'Rpm', forma: null, nip: n, name: 'Jan Testowy' });
    const r = light({ src: 'Rpz', nip: n, name: 'Testowy Jan' });
    const { derived } = deriveAll([p, r], null);
    expect(derived[0]!.entityType).toBe(ENTITY_TYPE.JDG);
    expect(derived[0]!.qflags & QFLAG.ACCOUNT_CHECK).toBe(0);
  });
});

describe('VAL-R2-1 person proposals use the practice\'s own licence only', () => {
  it('links a group practice to its partner as "partner", never as "person"', () => {
    const ind = light({ src: 'Rpz', nip: nip(666666661), name: 'Anna Próbna', npwz: ['7654321'] });
    const grp = light({ src: 'Rpzg', typ: 'grupowa', nip: null, name: 'Grupa Testowa', npwz: [], partnerNpwz: ['7654321'], partnerNips: [] });
    const { proposals } = deriveAll([ind, grp], null);
    expect(proposals.filter((x) => x.kind === 'person')).toHaveLength(0);
    const partner = proposals.filter((x) => x.kind === 'partner');
    expect(partner).toHaveLength(1);
    expect(partner[0]!.matchValue).toBe('npwz:lek:7654321');
    expect(partner[0]!.members).toHaveLength(2);
  });
  it('still pairs two individual practices of one person', () => {
    const a = light({ src: 'Rpz', nip: nip(666666662), name: 'Anna Próbna', npwz: ['7654322'] });
    const b = light({ src: 'Rpz', nip: nip(666666700), name: 'Anna Próbna', npwz: ['7654322'] });
    expect(deriveAll([a, b], null).proposals.filter((x) => x.kind === 'person')).toHaveLength(1);
  });
});

describe('VAL-R2-3 account check collapses one person with a middle name or two professions', () => {
  it('does not flag nested names, flags different given names', () => {
    const n = nip(666666664);
    const a = light({ src: 'Rpz', nip: n, name: 'Anna Maria Próbna', npwz: ['1111111'] });
    const b = light({ src: 'Rpzp', nip: n, name: 'Anna Próbna', npwz: ['2222222'] });
    expect(deriveAll([a, b], null).derived[0]!.qflags & QFLAG.ACCOUNT_CHECK).toBe(0);
    const c = light({ src: 'Rpz', nip: nip(666666665), name: 'A. B. Testowy', npwz: ['3333333'] });
    const d = light({ src: 'Rpz', nip: nip(666666665), name: 'Adam Testowy', npwz: ['4444444'] });
    expect(deriveAll([c, d], null).derived[0]!.qflags & QFLAG.ACCOUNT_CHECK).toBe(0);
    const e = light({ src: 'Rpz', nip: nip(666666666), name: 'Anna Testowska', npwz: ['5555555'] });
    const f = light({ src: 'Rpz', nip: nip(666666666), name: 'Jan Testowska', npwz: ['6666666'] });
    expect(deriveAll([e, f], null).derived[0]!.qflags & QFLAG.ACCOUNT_CHECK).toBeTruthy();
  });
});

describe('VAL-R2-5 www proposals', () => {
  it('is weak when a practitioner only lists a clinic\'s site, strong for two podmioty', () => {
    const p1 = light({ ...PODMIOT, name: 'Klinika Alfa', nip: nip(777777771), www: 'https://alfa-klinika.example' });
    const r1 = light({ src: 'Rpz', name: 'Jan Zielony', nip: nip(777777772), www: 'https://alfa-klinika.example' });
    const w1 = deriveAll([p1, r1], null).proposals.filter((x) => x.kind === 'www');
    expect(w1).toHaveLength(1);
    expect(w1[0]!.confidence).toBeLessThan(50);
    const p2 = light({ ...PODMIOT, name: 'Klinika Beta', nip: nip(777777773), www: 'https://alfa-klinika.example' });
    const w2 = deriveAll([p1, p2], null).proposals.filter((x) => x.kind === 'www');
    expect(w2[0]!.confidence).toBe(80);
  });
});
