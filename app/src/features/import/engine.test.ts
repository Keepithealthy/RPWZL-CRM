import { createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { ENTITY_TYPE, NIP_STATUS, QFLAG, type ValDecisions } from '../../lib/contract';
import { ImportEngine, SEND, type EngineRec } from './engine';
import { buildIndex, fakePodmiot, fakePraktyka, gzipText, standardDataset, validNip } from './fixtures';
import { MSG_CORRUPT, MSG_FORMAT_CHANGED, MSG_LAYOUT, MSG_NOT_INDEX, MSG_RESAVE, MSG_V1 } from './parse';
import { REC_SOFT_LIMIT } from './map';

const blobOf = (data: string | Uint8Array, name = 'rpwdl-index-test.json.gz') => {
  const b = new NodeBlob([data]);
  return Object.assign(b, { name }) as unknown as import('./parse').BlobLike;
};

/** What `import_state` would return after the engine's file had been imported. */
function stateOf(engine: ImportEngine, opts: { inRegister?: boolean } = {}): string {
  const { recs } = engine.debug();
  return recs
    .map((r: EngineRec, i: number) => [i + 1, r.keyHash, r.hAll, r.hContact, r.hDerived, opts.inRegister === false ? 0 : 1, r.kind === 'p' ? 0 : ['Rpm', 'Rpz', 'Rpzg', 'Rpzp'].indexOf(r.src)].join('\t'))
    .join('\n');
}

async function scanned(text: string, decisions: ValDecisions | null = null) {
  const e = new ImportEngine();
  e.setDecisions(decisions);
  const res = await e.scan(blobOf(text));
  return { e, res };
}

describe('reading the index', () => {
  it('reads a v2 plain file: header, counts, report date', async () => {
    const { p, r } = standardDataset();
    const { res } = await scanned(buildIndex({ p, r }));
    expect(res.records).toBe(p.length + r.length);
    expect(res.rejected).toBe(0);
    expect(res.reportDate).toBe('2026-11-14');
    expect(res.header.sources.map((s) => s.id)).toEqual(['Rpm', 'Rpz', 'Rpzg', 'Rpzp']);
    expect(res.bySource.Rpm).toBe(p.length);
  });

  it('reads a gzipped file and hashes the compressed bytes', async () => {
    const { p, r } = standardDataset();
    const gz = await gzipText(buildIndex({ p, r }));
    const e = new ImportEngine();
    const res = await e.scan(blobOf(gz));
    expect(res.records).toBe(p.length + r.length);
    expect(res.fileSha256).toBe(createHash('sha256').update(gz).digest('hex'));
  });

  it('reports a truncated or corrupt gzip as a damaged file with the re-save advice (UX-R5-1)', async () => {
    const { p, r } = standardDataset();
    const gz = await gzipText(buildIndex({ p, r }));
    const cut = gz.slice(0, Math.floor(gz.length / 2));
    await expect(new ImportEngine().scan(blobOf(cut))).rejects.toMatchObject({ messagePl: MSG_CORRUPT });
    const bad = gz.slice();
    bad.fill(0x41, 12, 40); // valid gzip magic, broken deflate stream
    await expect(new ImportEngine().scan(blobOf(bad))).rejects.toMatchObject({ messagePl: MSG_CORRUPT });
    expect(MSG_CORRUPT.startsWith('Plik jest niekompletny albo uszkodzony (np. przerwane pobieranie). ')).toBe(true);
    expect(MSG_CORRUPT.endsWith(MSG_RESAVE)).toBe(true);
  });

  it('handles CRLF line endings', async () => {
    const { p, r } = standardDataset();
    const { res } = await scanned(buildIndex({ p, r, crlf: true }));
    expect(res.records).toBe(p.length + r.length);
  });

  it('refuses a v1 index with the contract message', async () => {
    const { p, r } = standardDataset();
    await expect(scanned(buildIndex({ p, r, version: 1 }))).rejects.toMatchObject({ messagePl: MSG_V1 });
  });

  it('refuses other versions, other formats and foreign layouts', async () => {
    const { p, r } = standardDataset();
    await expect(scanned(buildIndex({ p, r, version: 3 }))).rejects.toThrow(/nowsza wersja narzędzia RPWDL \(wersja indeksu 3\) — CRM trzeba zaktualizować/);
    await expect(scanned(buildIndex({ p, r, format: 'something-else' }))).rejects.toThrow(/nie jest plik indeksu/);
    // UX-R4-2: another JSON or plain text is "not an index"; a broken index layout says so and tells what to do next
    await expect(scanned('{"a":1}\n')).rejects.toMatchObject({ messagePl: MSG_NOT_INDEX });
    await expect(scanned('to jest zwykły tekst\n')).rejects.toMatchObject({ messagePl: MSG_NOT_INDEX });
    await expect(scanned('{"format":"rpwdl-lead-index","version":2}\n')).rejects.toMatchObject({ messagePl: MSG_LAYOUT });
    expect(MSG_LAYOUT).toMatch(/Zapisz indeks ponownie .* wybierz nowy plik/);
    await expect(scanned('')).rejects.toThrow();
  });

  it('rejects damaged records and counts them without stopping', async () => {
    const { p, r } = standardDataset();
    const text = buildIndex({
      p: [...p, fakePodmiot(90, { noD: true }), fakePodmiot(91, { d: '{"zm":"2025-01-01"}' }), fakePodmiot(92, { d: 'not json' })],
      r,
      rawP: ['{"k":"p", broken'],
    });
    const { res } = await scanned(text);
    expect(res.records).toBe(p.length + r.length);
    expect(res.rejected).toBe(4);
    expect(Object.keys(res.rejectedReasons).length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a file whose format looks changed (no name or NIP in most records)', async () => {
    const p = Array.from({ length: 30 }, (_, i) => fakePodmiot(i + 1, { name: undefined, nip: null }));
    const bad = p.map((x) => ({ ...x, name: null, nip: null }));
    await expect(scanned(buildIndex({ p: bad }))).rejects.toMatchObject({ messagePl: MSG_FORMAT_CHANGED });
  });

  it('refuses a source of 50+ records with no contact data at all', async () => {
    const p = Array.from({ length: 50 }, (_, i) => fakePodmiot(i + 1, { email: null, emails: [], tel: null, phones: [] }));
    await expect(scanned(buildIndex({ p }))).rejects.toMatchObject({ messagePl: MSG_FORMAT_CHANGED });
  });
});

describe('identity and hashes', () => {
  it('keyHash is the first 8 bytes of SHA-256 of the register key and kseq orders collisions', async () => {
    const { p, r } = standardDataset();
    const { e } = await scanned(buildIndex({ p, r }));
    const { recs } = e.debug();
    for (const rec of recs) {
      const regKey = `${rec.regGroup}|${rec.kseq}`;
      expect(rec.keyHash).toBe(createHash('sha256').update(regKey, 'utf8').digest('hex').slice(0, 16));
    }
    const dups = recs.filter((x) => x.regGroup.endsWith('|DUP/1'));
    expect(dups.map((x) => x.kseq).sort()).toEqual([1, 2]);
    expect(dups.every((x) => x.regDup)).toBe(true);
    expect(dups.find((x) => x.name === 'Dubel A')?.kseq).toBe(1); // same wpis, name order
    expect(recs.filter((x) => !x.regDup).every((x) => x.kseq === 1)).toBe(true);
    expect(new Set(recs.map((x) => x.keyHash)).size).toBe(recs.length);
  });

  it('hashes are decimal int64 strings, stable across runs and sensitive to content', async () => {
    const { p, r } = standardDataset();
    const a = (await scanned(buildIndex({ p, r }))).e.debug().recs;
    const b = (await scanned(buildIndex({ p, r }))).e.debug().recs;
    expect(a.map((x) => x.hAll)).toEqual(b.map((x) => x.hAll));
    for (const x of a) {
      expect(x.hAll).toMatch(/^-?\d{1,19}$/);
      expect(x.hContact).toMatch(/^-?\d{1,19}$/);
      expect(x.hDerived).toMatch(/^-?\d{1,19}$/);
    }
    const p2 = p.map((x, i) => (i === 3 ? { ...x, miasto: 'Inne Miasto' } : x));
    const c = (await scanned(buildIndex({ p: p2, r }))).e.debug().recs;
    expect(c[3]?.hAll).not.toBe(a[3]?.hAll);
    expect(c[3]?.hContact).toBe(a[3]?.hContact); // only the city changed
    expect(c.filter((x, i) => x.hAll !== a[i]?.hAll)).toHaveLength(1);
  });
});

describe('validation over the file', () => {
  it('types entities, links accounts by NIP and flags NIP problems', async () => {
    const { p, r } = standardDataset();
    const { e } = await scanned(buildIndex({ p, r }));
    const d = e.debug().derived;
    // p[0] and r[0] share a valid NIP: one account of 2 entries; the podmiot is primary
    expect(d[0]?.accountKey).toBe(d[p.length]?.accountKey);
    expect(d[0]?.accountSize).toBe(2);
    expect(d[0]?.isAccountPrimary).toBe(true);
    expect(d[p.length]?.isAccountPrimary).toBe(false);
    expect(d[0]!.qflags & QFLAG.ACCOUNT_CHECK).toBeTruthy();
    expect(d[p.length]!.qflags & QFLAG.ACCOUNT_CHECK).toBeTruthy();
    // JDG podmiot + its practice: types {2,4} are linked without review
    expect(d[5]?.entityType).toBe(ENTITY_TYPE.JDG);
    expect(d[5]?.accountSize).toBe(2);
    expect(d[5]!.qflags & QFLAG.ACCOUNT_CHECK).toBe(0);
    expect(d[6]?.entityType).toBe(ENTITY_TYPE.PUBLICZNY);
    expect(d[p.length + 5]?.entityType).toBe(ENTITY_TYPE.PRAKTYKA_GRUP);
    expect(d[7]?.nipStatus).toBe(NIP_STATUS.CHECKSUM);
    expect(d[7]?.accountKey.startsWith('e:')).toBe(true);
    expect(d[8]?.nipStatus).toBe(NIP_STATUS.PLACEHOLDER);
    expect(d[p.length + 6]?.nipStatus).toBe(NIP_STATUS.NONE);
    expect(d[7]!.qflags & QFLAG.NO_CONTACT).toBeTruthy();
    expect(d[7]!.qflags & QFLAG.NIP_CHECKSUM).toBeTruthy();
    expect(d[8]!.qflags & QFLAG.NIP_PLACEHOLDER).toBeTruthy();
  });

  it('scores contacts and sets quality flags', async () => {
    const { p, r } = standardDataset();
    const { e } = await scanned(buildIndex({ p, r }));
    const d = e.debug().derived;
    expect(d[5]!.qflags & QFLAG.EMAIL_TYPO).toBeTruthy();
    expect(d[5]!.qEmail).toBe(10);
    expect(d[5]?.mobile).toBe('501555006');
    expect(d[0]!.qflags & QFLAG.EMAIL_ROLE).toBeTruthy();
    expect(d[0]?.telNorm).toBe('225550001');
    expect(d[1]?.mobile).toBe('601555002');
    expect(d[8]!.qflags & QFLAG.WWW_INVALID).toBeTruthy();
    expect(d[8]!.qflags & QFLAG.PHONE_UNPARSEABLE).toBeTruthy();
    expect(d[p.length + 6]!.qflags & QFLAG.WWW_SOCIAL).toBeTruthy();
    expect(d[p.length + 7]!.qflags & QFLAG.PHONE_UNPARSEABLE).toBeTruthy(); // 7-digit local number
    expect(d[12]!.qflags & QFLAG.INACTIVE).toBeTruthy();
    expect(d[12]!.qflags & QFLAG.STALE).toBeTruthy();
    expect(d[p.length + 5]!.qflags & QFLAG.GROUP_NIP_IS_PARTNER).toBeTruthy();
    expect(d[3]!.qflags & QFLAG.EMAIL_SHARED).toBeTruthy(); // the same e-mail on two NIPs
    expect(d[0]?.formType).toBe('komercyjna');
    expect(d[6]?.formType).toBe('publiczna');
    expect(d[6]?.spec1).toBe(2); // 1100, 1110; 1810 is dental
    expect(d[p.length]?.formType).toBeNull();
    expect(d[p.length]?.spec1).toBeNull();
  });

  it('proposes networks, duplicates and persons with evidence-based confidence', async () => {
    const { p, r } = standardDataset();
    const { e, res } = await scanned(buildIndex({ p, r }));
    const props = e.debug().proposals;
    const find = (kind: string, value: string) => props.find((x) => x.kind === kind && x.matchValue === value);
    expect(find('email', 'wspolny@przychodnia.example.pl')).toMatchObject({ confidence: 85 });
    expect(find('email', 'wspolny@przychodnia.example.pl')?.members).toHaveLength(2);
    expect(find('domain', 'siec-a.example.pl')).toMatchObject({ confidence: 70 });
    expect(find('domain', 'siec-a.example.pl')?.members).toHaveLength(3);
    expect(find('www', 'siec-a.example.pl')).toMatchObject({ confidence: 80 });
    expect(find('domain', 'przychodnia.example.pl')).toBeUndefined(); // same members as the e-mail proposal
    expect(find('person', 'npwz:lek:7654321')).toMatchObject({ confidence: 90 });
    expect(props.filter((x) => x.kind === 'reg_duplicate')).toHaveLength(1);
    expect(props.filter((x) => x.kind === 'account_check')).toHaveLength(1);
    const partner = props.filter((x) => x.kind === 'partner');
    expect(partner.length).toBeGreaterThanOrEqual(1);
    expect(partner[0]?.confidence).toBe(75);
    // a podmiot plus a practitioner sharing a phone is not a network proposal (VAL-2)
    expect(props.find((x) => x.kind === 'phone' && x.matchValue === '225550004')).toBeUndefined();
    // generic government domain is never a network signal
    expect(props.some((x) => x.kind === 'domain' && x.matchValue.endsWith('gov.pl'))).toBe(false);
    // identical member sets share a groupKey; groupKey is 16 hex
    const a = find('email', 'wspolny@przychodnia.example.pl');
    expect(a?.groupKey).toMatch(/^[0-9a-f]{16}$/);
    expect(res.proposalCounts.email).toBe(1);
    // members are sorted account keys
    for (const x of props) expect([...x.members].sort()).toEqual(x.members);
  });

  it('automatically marks widely shared company domains as generic', async () => {
    const wojs = ['a', 'b', 'c'];
    const p = Array.from({ length: 31 }, (_, i) => {
      const mail = `osoba${i}@kancelaria.example.pl`;
      return fakePodmiot(i + 1, { email: mail, emails: [mail], woj: wojs[i % 3] });
    });
    const { e, res } = await scanned(buildIndex({ p }));
    expect(res.autoGenericDomains).toEqual(['kancelaria.example.pl']);
    expect(e.debug().proposals.some((x) => x.kind === 'domain')).toBe(false);
  });

  it('respects stored decisions: detach and attach change the account key', async () => {
    const { p, r } = standardDataset();
    const text = buildIndex({ p, r });
    const first = (await scanned(text)).e.debug();
    const hash = first.recs[p.length]!.keyHash; // the practice sharing p[0]'s NIP
    const decisions: ValDecisions = {
      detach: [hash],
      attach: [{ keyHash: first.recs[1]!.keyHash, accountKey: first.derived[3]!.accountKey }],
      genericDomains: [],
      decidedProposals: [],
      params: undefined as never,
    };
    const second = (await scanned(text, decisions)).e.debug();
    expect(second.derived[p.length]?.accountKey).toBe('e:' + hash);
    expect(second.derived[0]?.accountSize).toBe(1);
    expect(second.derived[1]?.accountKey).toBe(first.derived[3]?.accountKey);
    expect(second.proposals.some((x) => x.kind === 'account_check')).toBe(false);
  });

  it('counts only proposals that stay open: decided ones are left out unless they gained members (RD3-2)', async () => {
    const { p, r } = standardDataset();
    const text = buildIndex({ p, r });
    const first = await scanned(text);
    const all = first.e.debug().proposals;
    expect(all.length).toBeGreaterThan(0);
    const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
    expect(total(first.res.proposalCounts)).toBe(all.length);
    const target = all[0]!;
    const base: ValDecisions = { detach: [], attach: [], genericDomains: [], decidedProposals: [], params: undefined as never };
    const decided = { ...base, decidedProposals: [{ kind: target.kind, matchValue: target.matchValue, members: target.members }] };
    const second = await scanned(text, decided);
    expect(total(second.res.proposalCounts)).toBe(all.length - 1);
    // a decision taken on fewer members does not hide the proposal: it reopens on import
    const fewer = { ...base, decidedProposals: [{ kind: target.kind, matchValue: target.matchValue, members: target.members.slice(1) }] };
    if (target.members.length > 0) expect(total((await scanned(text, fewer)).res.proposalCounts)).toBe(all.length);
  });

  it('applies owner-edited generic domains', async () => {
    const { p, r } = standardDataset();
    const decisions: ValDecisions = {
      detach: [], attach: [], genericDomains: [{ domain: 'siec-a.example.pl', kind: 'generic', suggestion: null }], decidedProposals: [], params: undefined as never,
    };
    const { e } = await scanned(buildIndex({ p, r }), decisions);
    expect(e.debug().proposals.some((x) => x.kind === 'domain' && x.matchValue === 'siec-a.example.pl')).toBe(false);
  });
});

describe('comparing with the database', () => {
  it('first import: everything is new and the rows follow the contract', async () => {
    const { p, r } = standardDataset();
    const { e } = await scanned(buildIndex({ p, r }));
    const plan = e.plan();
    expect(plan.total).toMatchObject({ total: p.length + r.length, new: p.length + r.length, changed: 0, gone: 0, unchanged: 0, derivedOnly: 0, rejected: 0 });
    expect(plan.byKind.p.new).toBe(p.length);
    expect(plan.byKind.r.new).toBe(r.length);
    const rows = [];
    for (;;) {
      const batch = await e.nextEntries(5);
      if (!batch.length) break;
      expect(batch.length).toBeLessThanOrEqual(5);
      rows.push(...batch);
    }
    expect(rows).toHaveLength(p.length + r.length);
    const row = rows[0]!;
    expect(row.kind).toBe('p');
    expect(row.src).toBe('Rpm');
    expect(row.regKey).toBe(`Rpm|Wojewoda Testowy|100001|1`);
    expect(row.ks).toBe('100001');
    expect(row.org).toBe('Wojewoda Testowy');
    expect(row.emails).toEqual(['rejestracja@siec-a.example.pl']);
    expect(row.facets['p.formType']).toEqual(['komercyjna']);
    expect(row.facets['p.status']).toEqual(['aktywny']);
    expect(row.facets['p.woj']).toEqual(['testowe']);
    expect(row.rec.d).toMatchObject({ ks: '100001', org: 'Wojewoda Testowy' });
    expect(row.rec.emails).toEqual(['rejestracja@siec-a.example.pl']);
    expect(row.derived.accountSize).toBe(2);
    expect(row.nz).toBe(1);
    const pr = rows[p.length]!;
    expect(pr.kind).toBe('r');
    expect(pr.org).toBe('Okręgowa Izba Testowa');
    expect(pr.emails).toEqual([]);
    expect(pr.nz).toBeNull();
    expect(pr.facets['r.src']).toEqual(['Rpz']);
    expect(pr.facets['r.typ']).toEqual(['indywidualna']);
    expect(pr.rec).not.toHaveProperty('emails');
    expect(pr.rec.d).toMatchObject({ npwz: '1000001' });
    // the second pass delivers exactly the rows of the plan, in file order
    expect(rows.map((x) => x.keyHash)).toEqual(e.debug().recs.map((x) => x.keyHash));
  });

  it('a second import of the same file changes nothing', async () => {
    const { p, r } = standardDataset();
    const text = buildIndex({ p, r });
    const first = (await scanned(text)).e;
    const second = new ImportEngine();
    await second.scan(blobOf(text));
    second.addState(stateOf(first));
    const plan = second.plan();
    expect(plan.total).toMatchObject({ new: 0, changed: 0, returned: 0, gone: 0, derivedOnly: 0, unchanged: p.length + r.length });
    expect(await second.nextEntries(10)).toEqual([]);
    expect(second.nextGone(10)).toEqual([]);
    expect(second.nextDerived(10)).toEqual([]);
    expect(second.entriesToSend()).toBe(0);
  });

  it('classifies new, changed (contact), returned, derived-only and gone entries', async () => {
    const { p, r } = standardDataset();
    const first = (await scanned(buildIndex({ p, r }))).e;
    const state = stateOf(first).split('\n');
    // mark the last podmiot as no longer in the register (it comes back in the new file)
    const lastP = p.length - 1;
    state[lastP] = state[lastP]!.replace(/\t1\t(\d+)$/, '\t0\t$1');
    // an entry the new file does not contain any more (a practice of a fully contained source)
    const ghost = ['9999', 'aaaaaaaaaaaaaaaa', '1', '1', '1', '1', '1'].join('\t');

    const p2 = p.map((x, i) => {
      if (i === 1) return { ...x, email: 'nowy@siec-a.example.pl', emails: ['nowy@siec-a.example.pl'] }; // contact change
      if (i === 2) return { ...x, miasto: 'Nowe Miasto' }; // other change
      return x;
    });
    // derived-only: a new practice with the NIP of an unchanged podmiot changes that podmiot's account size, not its register data
    const extra = fakePraktyka(40, { nip: p[3]!.nip as string });
    const p3 = [...p2, fakePodmiot(50)];
    const second = new ImportEngine();
    await second.scan(blobOf(buildIndex({ p: p3, r: [...r, extra] })));
    second.addState([...state, ghost].join('\n'));
    const plan = second.plan();
    expect(plan.total.new).toBe(2); // fakePodmiot(50) and the extra practice
    expect(plan.total.changed).toBe(2);
    expect(plan.total.changedContact).toBe(1);
    expect(plan.total.returned).toBe(1);
    expect(plan.total.gone).toBe(1);
    expect(plan.total.derivedOnly).toBeGreaterThanOrEqual(1);
    expect(plan.total.total).toBe(p3.length + r.length + 1);
    expect(plan.candidates.filter((c) => c.change === 'gone')).toEqual([{ id: 9999, keyHash: 'aaaaaaaaaaaaaaaa', change: 'gone' }]);
    expect(plan.candidates.filter((c) => c.change === 'contact')).toHaveLength(1);
    const sent = [];
    for (;;) {
      const b = await second.nextEntries(3);
      if (!b.length) break;
      sent.push(...b);
    }
    expect(sent).toHaveLength(second.entriesToSend());
    expect(sent).toHaveLength(2 + 2 + 1);
    expect(second.nextGone(10)).toEqual(['aaaaaaaaaaaaaaaa']);
    const der = second.nextDerived(2000);
    expect(der).toHaveLength(plan.total.derivedOnly);
    expect(der[0]?.derived).toBeDefined();
    const props = second.nextProposals(1);
    expect(props.rows).toHaveLength(1);
    expect(props.last).toBe(false);
    expect(second.nextProposals(10000).last).toBe(true);
  });

  it('does not mark entries of sources absent from the file as gone, and warns about > 10 % gone', async () => {
    const { p, r } = standardDataset();
    const first = (await scanned(buildIndex({ p, r }))).e;
    // the new file only contains podmioty (header lists Rpm only)
    const second = new ImportEngine();
    await second.scan(blobOf(buildIndex({ p })));
    second.addState(stateOf(first));
    const plan = second.plan();
    expect(plan.total.gone).toBe(0);
    // a file that drops half of the podmioty
    const third = new ImportEngine();
    await third.scan(blobOf(buildIndex({ p: p.slice(0, 6), r })));
    third.addState(stateOf(first));
    const plan3 = third.plan();
    expect(plan3.total.gone).toBe(p.length - 6);
    expect(plan3.sourcesOver10PercentGone).toContain('Rpm');
  });

  it('builds the import_begin payload', async () => {
    const { p, r } = standardDataset();
    const { e } = await scanned(buildIndex({ p, r }));
    e.plan();
    const meta = e.beginInput('rpwdl-index-2026-11-14.json.gz');
    expect(meta).toMatchObject({ indexVersion: 2, hashVersion: 1, reportDate: '2026-11-14', today: '2026-11-14', fileName: 'rpwdl-index-2026-11-14.json.gz' });
    expect(meta.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.sources.find((s) => s.id === 'Rpm')?.records).toBe(p.length);
    expect(meta.preview.new).toBe(p.length + r.length);
  });

  it('labels the specialties and functions seen in the data', async () => {
    const { p, r } = standardDataset();
    const { e } = await scanned(buildIndex({ p, r }));
    const labels = e.labels();
    expect(labels).toContainEqual({ facet: 'p.spec', val: '0100', label: '0100 — Podstawowa opieka zdrowotna testowa' });
    expect(labels).toContainEqual({ facet: 'p.fn', val: 'HC.1.3.1.', label: 'Usługi testowe' });
    expect(labels).toContainEqual({ facet: 'p.grp', val: '0', label: '0 — Podstawowa opieka zdrowotna' });
    expect(labels).toContainEqual({ facet: 'r.src', val: 'Rpz', label: 'Praktyki lekarskie indywidualne' });
    expect(labels.every((l) => l.label)).toBe(true);
  });

  it('shrinks a detail that would exceed the database row limit', async () => {
    const { e, res } = await scanned(buildIndex({ p: [fakePodmiot(1, { huge: 30000, spec: ['0100'] }), fakePodmiot(2)] }));
    expect(res.reducedDetail).toBe(1);
    e.plan();
    const rows = await e.nextEntries(10, 100_000_000);
    expect(rows).toHaveLength(2);
    const big = rows[0]!;
    expect(JSON.stringify(big.rec).length).toBeLessThan(REC_SOFT_LIMIT + 100_000);
    expect((big.rec.d as Record<string, unknown>).trunc).toEqual(['z']);
    expect(rows[1]!.rec.d).not.toHaveProperty('trunc');
  });

  it('detects a file that changed between the two passes', async () => {
    const { p, r } = standardDataset();
    const e = new ImportEngine();
    const blob = blobOf(buildIndex({ p, r }));
    await e.scan(blob);
    e.plan();
    // replace the blob by one with a different record order
    (e as unknown as { blob: unknown }).blob = blobOf(buildIndex({ p: [...p].reverse(), r }));
    await expect(e.nextEntries(5)).rejects.toThrow(/zmienił się/);
  });
});

describe('send codes', () => {
  it('exports stable codes', () => {
    expect(SEND).toEqual({ NONE: 0, NEW: 1, CHANGED: 2, RETURNED: 3, DERIVED: 4 });
    expect(validNip(1)).toHaveLength(10);
  });
});
