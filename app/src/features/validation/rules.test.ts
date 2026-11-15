import { describe, expect, it } from 'vitest';
import { ENTITY_TYPE, NIP_STATUS, QFLAG } from '../../lib/contract';
import {
  classifyDomain, cleanName, editDistance, emailDomain, emailQuality, emailRole, entityType, firstMobile, formTypeOf,
  isStale, isValidEmail, nipKey, nipStatus, normalizeEmail, normalizeWww, parsePhone, phoneClass, phoneQuality,
  qflagLabels, qualityLabel, recordNums, spec1Count, wwwQuality, type DomainTable,
} from './rules';

/** Valid synthetic NIP: first nine digits, last digit = checksum. */
function makeNip(nine: string): string {
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  for (let n = Number(nine); ; n++) {
    const s = String(n);
    const c = s.split('').reduce((a, d, i) => a + Number(d) * (w[i] as number), 0) % 11;
    if (c !== 10) return s + String(c);
  }
}

describe('phones', () => {
  it('classifies by the first two digits', () => {
    expect(phoneClass('601234567')).toBe('kom');
    expect(phoneClass('221234567')).toBe('stac');
    expect(phoneClass('481234567')).toBe('stac'); // 48 is Radom, never a country code on 9 digits
    expect(phoneClass('801234567')).toBe('inny');
    expect(phoneClass('101234567')).toBe('zly');
    expect(phoneClass('012345678')).toBe('zly');
    expect(phoneClass('12345')).toBe('zly');
  });

  it('parses the formats found in the register', () => {
    expect(parsePhone('601 234 567')).toEqual([{ n: '601234567', cls: 'kom' }]);
    expect(parsePhone('+48 601-234-567')).toEqual([{ n: '601234567', cls: 'kom' }]);
    expect(parsePhone('0048601234567')).toEqual([{ n: '601234567', cls: 'kom' }]);
    expect(parsePhone('022 123 45 67')).toEqual([{ n: '221234567', cls: 'stac' }]);
    expect(parsePhone('(22) 123 45 67 wew. 12')).toEqual([{ n: '221234567', cls: 'stac' }]);
  });

  it('splits several numbers and de-duplicates', () => {
    const p = parsePhone('221234567, 601234567 lub 221234567; 22 765 43 21');
    expect(p.map((x) => x.n)).toEqual(['221234567', '601234567', '227654321']);
    // two glued 9-digit numbers
    expect(parsePhone('221234567601234567').map((x) => x.n)).toEqual(['221234567', '601234567']);
  });

  it('rejects what is not dialable without guessing', () => {
    expect(parsePhone('123 45 67')).toEqual([]); // 7-digit local number
    expect(parsePhone('-')).toEqual([]);
    expect(parsePhone('.')).toEqual([]);
    expect(parsePhone('')).toEqual([]);
    expect(parsePhone(null)).toEqual([]);
    expect(parsePhone('991234567')).toEqual([]); // AB 99 is reserved
  });

  it('ignores invisible characters and non-breaking spaces', () => {
    expect(parsePhone('601 234​567')).toEqual([{ n: '601234567', cls: 'kom' }]);
  });

  it('recordNums puts tel first and merges phones', () => {
    const nums = recordNums('221234567', ['601234567', '221234567', 'brak']);
    expect(nums.map((n) => n.n)).toEqual(['221234567', '601234567']);
    expect(firstMobile(nums)).toBe('601234567');
    expect(firstMobile(recordNums('221234567', []))).toBeNull();
  });

  it('phoneQuality follows SPEC 6.4', () => {
    expect(phoneQuality('kom', 1, false)).toBe(100);
    expect(phoneQuality('stac', 1, false)).toBe(85);
    expect(phoneQuality('inny', 1, false)).toBe(60);
    expect(phoneQuality('kom', 2, false)).toBe(90);
    expect(phoneQuality('kom', 4, false)).toBe(80);
    expect(phoneQuality('kom', 9, false)).toBe(65);
    expect(phoneQuality('kom', 10, false)).toBe(50);
    expect(phoneQuality('stac', 10, true)).toBe(25);
    expect(phoneQuality(null, 1, false)).toBe(0);
  });
});

describe('NIP', () => {
  it('checks status in the documented order', () => {
    expect(nipStatus(null)).toBe(NIP_STATUS.NONE);
    expect(nipStatus('')).toBe(NIP_STATUS.NONE);
    expect(nipStatus('12345')).toBe(NIP_STATUS.BAD_FORMAT);
    expect(nipStatus('0000000000')).toBe(NIP_STATUS.PLACEHOLDER);
    expect(nipStatus('1111111111')).toBe(NIP_STATUS.PLACEHOLDER);
    expect(nipStatus(makeNip('123456789'))).toBe(NIP_STATUS.OK);
    const ok = makeNip('123456789');
    const bad = ok.slice(0, 9) + String((Number(ok[9]) + 1) % 10);
    expect(nipStatus(bad)).toBe(NIP_STATUS.CHECKSUM);
  });

  it('mod 11 = 10 is invalid', () => {
    // 123456780: sum = 1*6+2*5+3*7+4*2+5*3+6*4+7*5+8*6+0*7 = 6+10+21+8+15+24+35+48 = 167, 167 % 11 = 2 -> pick one that gives 10
    let nine = '';
    for (let i = 100000000; i < 100000100; i++) {
      const s = String(i);
      const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
      if (s.split('').reduce((a, d, k) => a + Number(d) * (w[k] as number), 0) % 11 === 10) { nine = s; break; }
    }
    expect(nine).not.toBe('');
    expect(nipStatus(nine + '0')).toBe(NIP_STATUS.CHECKSUM);
  });

  it('nipKey keeps the offline tool semantics (no checksum)', () => {
    expect(nipKey('1234567890')).toBe('1234567890');
    expect(nipKey('0000000000')).toBeNull();
    expect(nipKey('123')).toBeNull();
    expect(nipKey(null)).toBeNull();
  });
});

describe('legal form and entity type', () => {
  it('formTypeOf', () => {
    expect(formTypeOf('samodzielny publiczny zakład opieki zdrowotnej')).toBe('publiczna');
    expect(formTypeOf('spółka z ograniczoną odpowiedzialnością, w której co najmniej 51% kapitału zakładowego ...')).toBe('publiczna');
    expect(formTypeOf('spółka z ograniczoną odpowiedzialnością')).toBe('komercyjna');
    expect(formTypeOf('działalność gospodarcza prowadzona przez osobę fizyczną')).toBe('komercyjna');
    expect(formTypeOf('działalność gospodarcza prowadzona przez osobę fizyczną bez celu osiągania zysku')).toBe('inna');
    expect(formTypeOf('spółka z o.o. be celu osiągania zysku')).toBe('inna');
    expect(formTypeOf('fundacja')).toBe('inna');
    expect(formTypeOf(null)).toBeNull();
  });

  it('entityType follows SPEC 6.1', () => {
    expect(entityType({ kind: 'p', src: 'Rpm', forma: 'jednostka budżetowa' })).toBe(ENTITY_TYPE.PUBLICZNY);
    expect(entityType({ kind: 'p', src: 'Rpm', forma: 'działalność gospodarcza prowadzona przez osobę fizyczną' })).toBe(ENTITY_TYPE.JDG);
    expect(entityType({ kind: 'p', src: 'Rpm', forma: 'działalność gospodarcza prowadzona przez osobę fizyczną bez celu osiągania zysku' })).toBe(ENTITY_TYPE.JDG);
    expect(entityType({ kind: 'p', src: 'Rpm', forma: 'spółka jawna' })).toBe(ENTITY_TYPE.PODMIOT_PRAWNY);
    expect(entityType({ kind: 'p', src: 'Rpm', forma: null })).toBe(ENTITY_TYPE.PODMIOT_PRAWNY);
    expect(entityType({ kind: 'r', src: 'Rpz', forma: null, typ: 'indywidualna' })).toBe(ENTITY_TYPE.PRAKTYKA_IND);
    expect(entityType({ kind: 'r', src: 'Rpz', forma: null, typ: 'grupowa' })).toBe(ENTITY_TYPE.PRAKTYKA_GRUP);
    expect(entityType({ kind: 'r', src: 'Rpzg', forma: null, typ: null })).toBe(ENTITY_TYPE.PRAKTYKA_GRUP);
  });

  it('spec1Count excludes dental 18xx and unknown codes, counts distinct', () => {
    expect(spec1Count(['1100', '1100', '1130', '1810', '1811', '?', '2000'])).toBe(2);
    expect(spec1Count([])).toBe(0);
    expect(spec1Count(null)).toBe(0);
  });

  it('cleanName', () => {
    expect(cleanName('  Przychodnia­​  Zdrowie \n Sp. z o.o.  ')).toBe('Przychodnia Zdrowie Sp. z o.o.');
    expect(cleanName(null)).toBe('');
  });
});

describe('e-mail', () => {
  it('normalises and validates', () => {
    expect(normalizeEmail(' <MAILTO:Biuro@Firma.PL> ')).toBe('biuro@firma.pl');
    expect(normalizeEmail('mailto:a@b.pl')).toBe('a@b.pl');
    expect(isValidEmail('osoba.testowa@firma.pl')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@firma.pl')).toBe(false);
    expect(isValidEmail('a..b@firma.pl')).toBe(false);
    expect(isValidEmail('@firma.pl')).toBe(false);
    expect(emailDomain('x@firma.pl')).toBe('firma.pl');
  });

  it('classifies domains', () => {
    expect(classifyDomain('gmail.com').cls).toBe('free');
    expect(classifyDomain('wp.pl').cls).toBe('free');
    expect(classifyDomain('gmial.com')).toEqual({ cls: 'typo', suggestion: 'gmail.com' });
    expect(classifyDomain('gmaill.com')).toEqual({ cls: 'typo', suggestion: 'gmail.com' }); // distance 1 from a base
    expect(classifyDomain('onet.pl').cls).toBe('free');
    expect(classifyDomain('sanepid.gov.pl').cls).toBe('generic');
    expect(classifyDomain('gov.pl').cls).toBe('generic');
    expect(classifyDomain('zoz.org.pl').cls).toBe('generic');
    expect(classifyDomain('firma-medyczna.pl').cls).toBe('company');
  });

  it('owner and automatic rows win over the built-in rules', () => {
    const t: DomainTable = new Map([['gmail.com', { kind: 'generic' as const, suggestion: null }], ['siec.pl', { kind: 'generic' as const, suggestion: null }]]);
    expect(classifyDomain('gmail.com', t).cls).toBe('generic');
    expect(classifyDomain('siec.pl', t).cls).toBe('generic');
    expect(classifyDomain('oddzial.siec.pl', t).cls).toBe('generic'); // a generic row covers sub-domains
    expect(classifyDomain('xyz-firma.pl', t).cls).toBe('company');
  });

  it('detects role mailboxes', () => {
    expect(emailRole('rejestracja@x.pl')).toBe('front');
    expect(emailRole('rejestracja+ortopedia@x.pl')).toBe('front');
    expect(emailRole('biuro@x.pl')).toBe('office');
    expect(emailRole('sekretariat.dyrekcja@x.pl')).toBe('office');
    expect(emailRole('osoba.testowa@x.pl')).toBeNull();
  });

  it('scores quality as in SPEC 6.4', () => {
    expect(emailQuality('osoba.testowa@firma.pl', 1, false)).toBe(100);
    expect(emailQuality('osoba.testowa@gmail.com', 1, false)).toBe(85);
    expect(emailQuality('rejestracja@firma.pl', 1, false)).toBe(85);
    expect(emailQuality('biuro@firma.pl', 1, false)).toBe(90);
    expect(emailQuality('biuro.testowe.0001@wp.pl', 3, true)).toBe(100 - 15 - 10 - 10 - 10);
    expect(emailQuality('x@firma.pl', 7, false)).toBe(80);
    expect(emailQuality('x@gmial.com', 1, false)).toBe(10);
    expect(emailQuality('nie-email', 1, false)).toBe(0);
    expect(emailQuality('x@sanepid.gov.pl', 1, false)).toBe(95);
    expect(qualityLabel(80)).toBe('dobry');
    expect(qualityLabel(60)).toBe('średni');
    expect(qualityLabel(10)).toBe('słaby');
    expect(qualityLabel(null)).toBeNull();
  });

  it('editDistance counts a transposition as one edit', () => {
    expect(editDistance('gmail.com', 'gmial.com')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('abc', 'xyz')).toBe(3);
    expect(editDistance('a', 'abcdef', 1)).toBe(2);
  });
});

describe('WWW', () => {
  it('normalises', () => {
    expect(normalizeWww('HTTPS://www.Firma.pl:8080/oferta?x=1#top')).toBe('firma.pl');
    expect(normalizeWww('www2.firma.pl/')).toBe('firma.pl');
    expect(normalizeWww('firma.pl.')).toBe('firma.pl');
  });

  it('flags invalid values with a reason', () => {
    for (const junk of ['-', 'brak', 'brak wpisu', 'ul.', 'www', 'n/d', '']) {
      expect(wwwQuality(junk).status).toBe('invalid');
    }
    expect(wwwQuality('kontakt@firma.pl').reason).toMatch(/e-mail/);
    expect(wwwQuality('moja firma.pl').status).toBe('invalid');
    expect(wwwQuality('localhost').status).toBe('invalid');
    expect(wwwQuality('firma.p1').status).toBe('invalid');
  });

  it('separates social hosts and returns the host for good values', () => {
    expect(wwwQuality('https://www.facebook.com/przychodnia')).toEqual({ host: 'facebook.com', status: 'social', reason: null });
    expect(wwwQuality('www.przychodnia.pl/kontakt')).toEqual({ host: 'przychodnia.pl', status: 'ok', reason: null });
  });
});

describe('staleness and flag labels', () => {
  it('isStale', () => {
    expect(isStale(null, '2023-11-10')).toBe(true);
    expect(isStale('2023-11-10', '2023-11-10')).toBe(true);
    expect(isStale('2023-11-11', '2023-11-10')).toBe(false);
  });

  it('qflagLabels lists Polish reasons for set bits only', () => {
    const l = qflagLabels(QFLAG.NIP_CHECKSUM | QFLAG.EMAIL_TYPO);
    expect(l).toContain('NIP z błędną sumą kontrolną');
    expect(l).toContain('możliwa literówka w e-mailu');
    expect(l).toHaveLength(2);
    expect(qflagLabels(QFLAG.STALE | QFLAG.NO_CONTACT, QFLAG.NO_CONTACT)).toEqual(['brak działającego kontaktu']);
  });
});
