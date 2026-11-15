/**
 * Synthetic `rpwdl-lead-index` generator for tests and demos (CONTRACT.md 1: "shared fixture generator").
 * Everything here is invented: names, NIPs, phones and e-mail domains do not describe real entities.
 */
import type { SourceId } from '../../lib/contract';

const W = [6, 5, 7, 2, 3, 4, 5, 6, 7];

/** A checksum-valid synthetic NIP derived from a seed (never a real register NIP by construction of the seed range). */
export function validNip(seed: number): string {
  // step 2: a skipped (checksum 10) value never collides with the next seed's NIP
  for (let n = 900_000_000 + seed * 2; ; n++) {
    const s = String(n);
    const c = s.split('').reduce((a, d, i) => a + Number(d) * (W[i] as number), 0) % 11;
    if (c !== 10) return s + String(c);
  }
}

/** The detail string as the offline tool stores it: JSON with every UTF-16 unit above U+00FF written as \uXXXX. */
export function escapeD(d: unknown): string {
  return JSON.stringify(d).replace(/[\u0100-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

type Rec = Record<string, unknown>;

export interface PodmiotOpts {
  name?: string; nip?: string | null; email?: string | null; emails?: string[]; tel?: string | null; phones?: string[]; www?: string | null;
  forma?: string | null; woj?: string; miasto?: string; ks?: string; org?: string; wpis?: string | null; stan?: string | null;
  status?: string; spec?: string[]; sc?: Array<[string | null, string | null]>; huge?: number; noD?: boolean; d?: string | null;
}

/** A podmiot (source Rpm) in the v2 record layout (key order of the tool's extractP + wpis + d). */
export function fakePodmiot(i: number, o: PodmiotOpts = {}): Rec {
  const spec = o.spec ?? ['0100'];
  const email = o.email === undefined ? `kontakt${i}@firma${i}.example.pl` : o.email;
  const emails = o.emails ?? (email ? [email] : []);
  const tel = o.tel === undefined ? `22 555 ${String(1000 + i).slice(-4).replace(/^(..)(..)$/, '$1 $2')}` : o.tel;
  const ks = o.ks ?? String(100000 + i);
  const org = o.org ?? 'Wojewoda Testowy';
  const komorki = spec.map((s, k) => ({ n: `Komórka ${k + 1}`, s, ...(k === 0 && o.huge ? { c: ['a@b.pl', null, null] } : {}) }));
  const filler = o.huge ? Array.from({ length: o.huge }, (_, k) => ({ n: `Komórka testowa numer ${k}`, s: spec[0] ?? '0100' })) : [];
  const d = {
    ks, zm: '2025-01-02', org,
    z: [{ n: `Zakład ${i}`, r: 0, a: `ul. Testowa ${i}, 00-001 Testowo, woj. testowe`, k: [...komorki, ...filler] }],
    ...(o.sc ? { sc: o.sc } : {}),
  };
  return {
    k: 'p', src: 'Rpm', name: o.name ?? `Przychodnia Testowa ${i}`, nip: o.nip === undefined ? validNip(i) : o.nip, email, www: o.www ?? null,
    tel, emails, phones: o.phones ?? (tel ? [tel] : []), forma: o.forma === undefined ? 'spółka z ograniczoną odpowiedzialnością' : o.forma,
    woj: o.woj ?? 'testowe', miasto: o.miasto ?? 'Testowo', ulica: `ul. Testowa ${i}`, kod: '00-001', status: o.status ?? 'aktywny',
    stan: o.stan === undefined ? '2025-06-01' : o.stan, rodzaje: ['Ambulatoryjne świadczenia zdrowotne'], grp: ['0'], spec, dz: ['medycyna rodzinna'],
    fn: ['HC.1.3.1.'], nz: 1, nk: spec.length + filler.length, wpis: o.wpis === undefined ? '2020-03-04' : o.wpis,
    d: o.noD ? null : o.d !== undefined ? o.d : escapeD(d),
  };
}

export interface PraktykaOpts {
  src?: SourceId; name?: string; nip?: string | null; tel?: string | null; phones?: string[]; www?: string | null; email?: string | null;
  typ?: string | null; woj?: string; miasto?: string; ks?: string; organ?: string; wpis?: string | null; stan?: string | null;
  status?: string; npwz?: string | null; partners?: Array<{ n?: string; nip?: string | null; npwz?: string | null }>;
}

/** A practice in the v2 record layout. */
export function fakePraktyka(i: number, o: PraktykaOpts = {}): Rec {
  const src = o.src ?? 'Rpz';
  const grupowa = src.endsWith('g');
  const tel = o.tel === undefined ? `601 555 ${String(100 + i).slice(-3)}` : o.tel;
  const organ = o.organ ?? 'Okręgowa Izba Testowa';
  const d = {
    ks: o.ks ?? String(500000 + i), zm: '2024-05-06', tyt: 'lekarz',
    ...(o.npwz === null ? {} : { npwz: o.npwz ?? String(1000000 + i) }),
    kor: `ul. Praktyczna ${i}, 00-002 Testowo`,
    a: [{ t: 0, ta: 0, ad: [[0, `ul. Praktyczna ${i}`, tel]] }],
    ...(o.partners ? { w: o.partners.map((p) => ({ n: p.n ?? 'Wspólnik Testowy', nip: p.nip ?? null, ...(p.npwz ? { npwz: p.npwz } : {}) })) } : {}),
  };
  return {
    k: 'r', src, name: o.name ?? `Gabinet Testowy ${i}`, nip: o.nip === undefined ? validNip(5000 + i) : o.nip, email: o.email ?? null, www: o.www ?? null, tel,
    phones: o.phones ?? (tel ? [tel] : []), grupaPraktyk: 'lekarska', typ: o.typ ?? (grupowa ? 'grupowa' : 'indywidualna'), forma: 'praktyka zawodowa',
    organ, status: o.status ?? 'active', woj: o.woj ?? 'testowe', miasto: o.miasto ?? 'Testowo', ulica: `ul. Praktyczna ${i}`, kod: '00-002',
    stan: o.stan === undefined ? '2024-02-02' : o.stan, gz: ['lekarz'], rodzaj: ['indywidualna praktyka lekarska'], rd: ['ambulatoryjne'],
    spec: ['medycyna rodzinna'], zakres: ['Lecznicze'], wpis: o.wpis === undefined ? '2019-01-01' : o.wpis, d: escapeD(d),
  };
}

const SOURCE_LABELS: Record<string, [string, string]> = {
  Rpm: ['Podmioty lecznicze', 'HEALTHCARE_PROVIDER.zip'],
  Rpz: ['Praktyki lekarskie indywidualne', 'PHYSICIAN_PRACTICE.zip'],
  Rpzg: ['Praktyki lekarskie grupowe', 'GROUP_PHYSICIAN_PRACTICE.zip'],
  Rpzp: ['Praktyki pielęgniarskie indywidualne', 'NURSING_PRACTICE.zip'],
};

export interface IndexOpts {
  version?: 1 | 2 | number;
  format?: string;
  today?: string;
  createdAt?: string;
  p?: Rec[];
  r?: Rec[];
  names?: { spec?: Record<string, string>; fn?: Record<string, string> };
  /** override the sources array (e.g. to declare a source with 0 records) */
  sources?: Array<Record<string, unknown>>;
  /** write raw extra lines inside the p section (e.g. broken JSON) */
  rawP?: string[];
  rawR?: string[];
  crlf?: boolean;
}

/** Index text in the tool's line layout. For version 1 the `wpis` and `d` keys are removed from every record. */
export function buildIndex(o: IndexOpts = {}): string {
  const version = o.version ?? 2;
  const p = o.p ?? [];
  const r = o.r ?? [];
  const today = o.today ?? '2026-11-14';
  const bySrc = new Map<string, number>();
  if (p.length) bySrc.set('Rpm', p.length);
  for (const x of r) bySrc.set(String(x.src), (bySrc.get(String(x.src)) ?? 0) + 1);
  const sources = o.sources ?? [...bySrc].map(([id, n]) => ({
    id, label: SOURCE_LABELS[id]?.[0] ?? id, records: n, reportDate: today, file: SOURCE_LABELS[id]?.[1] ?? `${id}.zip`, kind: id === 'Rpm' ? 'p' : 'r', today, bad: 0,
  }));
  const head = JSON.stringify({
    format: o.format ?? 'rpwdl-lead-index', version, today, createdAt: o.createdAt ?? `${today}T10:00:00.000Z`, sources,
    names: { spec: o.names?.spec ?? { '0100': 'Podstawowa opieka zdrowotna testowa', '1100': 'Poradnia testowa' }, fn: o.names?.fn ?? { 'HC.1.3.1.': 'Usługi testowe' } },
    records: {},
  }).slice(0, -2);
  const strip = (x: Rec): Rec => {
    if (version !== 1) return x;
    const { wpis: _w, d: _d, ...rest } = x;
    void _w; void _d;
    return rest;
  };
  const lines = (arr: Rec[], raw: string[] | undefined) => [...arr.map((x) => JSON.stringify(strip(x))), ...(raw ?? [])];
  const pl = lines(p, o.rawP);
  const rl = lines(r, o.rawR);
  const nl = o.crlf ? '\r\n' : '\n';
  const sep = (arr: string[]) => arr.map((l, i) => l + (i < arr.length - 1 ? ',' : ''));
  return [head, '"p":[', ...sep(pl), '],', '"r":[', ...sep(rl), ']', '}}', ''].join(nl);
}

export async function gzipText(text: string): Promise<Uint8Array> {
  const cs = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const chunks: Uint8Array[] = [];
  const reader = cs.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * A small dataset that exercises the validation rules. Expectations are documented next to each group and asserted in
 * engine.test.ts / derive.test.ts.
 */
export function standardDataset(): { p: Rec[]; r: Rec[] } {
  const sharedNip = validNip(1);
  const p: Rec[] = [
    // 0: ordinary company with a company e-mail and a landline
    fakePodmiot(1, { nip: sharedNip, email: 'rejestracja@siec-a.example.pl', emails: ['rejestracja@siec-a.example.pl'], tel: '22 555 00 01', www: 'https://www.siec-a.example.pl/kontakt' }),
    // 1, 2: two entities of one network: same company domain, different NIPs
    fakePodmiot(2, { email: 'biuro@siec-a.example.pl', emails: ['biuro@siec-a.example.pl'], tel: '601 555 002', www: 'siec-a.example.pl' }),
    fakePodmiot(3, { email: 'poczta@siec-a.example.pl', emails: ['poczta@siec-a.example.pl'], tel: '12 555 00 03' }),
    // 3, 4: the very same e-mail on two NIPs
    fakePodmiot(4, { email: 'wspolny@przychodnia.example.pl', emails: ['wspolny@przychodnia.example.pl'], tel: '22 555 00 04' }),
    fakePodmiot(5, { email: 'wspolny@przychodnia.example.pl', emails: ['wspolny@przychodnia.example.pl'], tel: '22 555 00 05' }),
    // 5: free mail + typo domain, JDG
    fakePodmiot(6, { forma: 'działalność gospodarcza prowadzona przez osobę fizyczną', name: 'Gabinet Lekarski Jan Testowy', email: 'jan@gmial.com', emails: ['jan@gmial.com'], tel: '501 555 006' }),
    // 6: public entity with a government domain
    fakePodmiot(7, { forma: 'samodzielny publiczny zakład opieki zdrowotnej', email: 'sekretariat@szpital.example.gov.pl', emails: ['sekretariat@szpital.example.gov.pl'], tel: '22 555 00 07', spec: ['1100', '1110', '1810', '0100'] }),
    // 7: NIP with a bad checksum, no contact at all
    fakePodmiot(8, { nip: '1234567891', email: null, emails: [], tel: null, phones: [], www: null }),
    // 8: placeholder NIP, www junk
    fakePodmiot(9, { nip: '0000000000', www: 'brak', tel: '-' }),
    // 9, 10: book number collision (same src, org, ks)
    fakePodmiot(10, { ks: 'DUP/1', name: 'Dubel A', wpis: '2020-01-01' }),
    fakePodmiot(11, { ks: 'DUP/1', name: 'Dubel B', wpis: '2020-01-01' }),
    // 11: s.c. partner whose NIP is another register entry's NIP
    fakePodmiot(12, { forma: 'spółka cywilna', sc: [['Partner Pierwszy', sharedNip], ['Partner Drugi', validNip(777)]] }),
    // 12: inactive, stale, no wpis
    fakePodmiot(13, { status: 'zakonczony', stan: '2023-11-10', wpis: null }),
  ];
  const r: Rec[] = [
    // practice sharing the NIP of podmiot 0: a company and a practice under one NIP -> account_check
    fakePraktyka(1, { nip: sharedNip, tel: '601 555 101' }),
    // the JDG owner's own practice (podmiot 5): same NIP and the same person, types JDG + practice -> linked without review
    fakePraktyka(2, { nip: validNip(6), tel: '22 555 00 06', name: 'Jan Testowy' }),
    // the same licence number on two different NIPs, one person (names nest: middle name, VAL-R3-5)
    fakePraktyka(3, { npwz: '7654321', name: 'Anna Testowa' }),
    fakePraktyka(4, { npwz: '7654321', name: 'Anna Maria Testowa' }),
    // shared landline (switchboard-like) with a podmiot (phone of podmiot 3)
    fakePraktyka(5, { tel: '22 555 00 04' }),
    // group practice whose NIP is its partner's NIP
    fakePraktyka(6, { src: 'Rpzg', nip: validNip(6001), partners: [{ nip: validNip(6001), npwz: '1234567' }, { nip: validNip(6002), npwz: '1234568' }] }),
    // no phone, no NIP
    fakePraktyka(7, { nip: null, tel: null, phones: [], www: 'https://facebook.com/gabinet7' }),
    // 7-digit local number only
    fakePraktyka(8, { tel: '555 01 02' }),
    fakePraktyka(9, { src: 'Rpzp', tel: '502 555 109' }),
  ];
  return { p, r };
}
