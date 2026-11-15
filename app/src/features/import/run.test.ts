import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { CrmError } from '../../lib/api';
import { LocalBackend } from './backend';
import { fakeDb } from './test-utils';
import { buildIndex, fakePodmiot, standardDataset } from './fixtures';
import {
  ImportCancelled, analyseFile, executeImport, nextBatchSize, withRetry, BATCH_MAX, BATCH_MIN, type RpcFn,
} from './run';

const blobOf = (text: string, name = 'rpwdl-index-2026-11-14.json.gz') => Object.assign(new NodeBlob([text]), { name }) as unknown as import('./parse').BlobLike & { name: string };
const noSleep = () => Promise.resolve();

async function fullImport(text: string, db: ReturnType<typeof fakeDb>, extra: Parameters<typeof executeImport>[3] = {}) {
  const backend = new LocalBackend();
  const analysis = await analyseFile(backend, db.rpc, blobOf(text));
  const run = await executeImport(backend, db.rpc, analysis, { sleep: noSleep, ...extra });
  return { backend, analysis, run };
}

describe('analyse and execute against a fake database', () => {
  it('first import sends everything in the contract order and finishes', async () => {
    const { p, r } = standardDataset();
    const db = fakeDb();
    const { analysis, run } = await fullImport(buildIndex({ p, r }), db);
    expect(analysis.plan.total.new).toBe(p.length + r.length);
    expect(analysis.warnings).toEqual([]);
    expect(analysis.blockers).toEqual([]);
    expect(db.entries.size).toBe(p.length + r.length);
    expect(run.status).toBe('applied');
    expect(run.counts?.new).toBe(p.length + r.length);
    const order = db.log.filter((n) => n.startsWith('import_') && n !== 'import_state' && n !== 'import_runs');
    expect(order[0]).toBe('import_begin');
    expect(order[1]).toBe('import_labels');
    expect(order.at(-1)).toBe('import_finish');
    expect(order.lastIndexOf('import_proposals')).toBeLessThan(order.indexOf('import_finish'));
    expect(db.finals.at(-1)).toBe(true);
    expect(db.finals.slice(0, -1).every((f) => !f)).toBe(true);
    expect(db.labels().length).toBeGreaterThan(0);
  });

  it('a repeated import of the same file sends no entries (idempotent / resumable)', async () => {
    const { p, r } = standardDataset();
    const db = fakeDb();
    const text = buildIndex({ p, r });
    await fullImport(text, db);
    const before = db.log.filter((n) => n === 'import_entries').length;
    const { analysis } = await fullImport(text, db);
    expect(analysis.plan.total.unchanged).toBe(p.length + r.length);
    expect(db.log.filter((n) => n === 'import_entries').length).toBe(before);
  });

  it('a failure aborts the run and the next attempt only sends what is missing', async () => {
    const p = Array.from({ length: 60 }, (_, i) => fakePodmiot(i + 1));
    const text = buildIndex({ p });
    const db = fakeDb({ failEntriesCalls: Array.from({ length: 200 }, (_, i) => i + 2) });
    const backend = new LocalBackend();
    const analysis = await analyseFile(backend, db.rpc, blobOf(text));
    const remembered: Array<unknown> = [];
    await expect(executeImport(backend, db.rpc, analysis, { sleep: noSleep, startBatch: 25, remember: (x) => remembered.push(x) })).rejects.toBeInstanceOf(CrmError);
    expect(db.log).toContain('import_abort');
    expect(remembered[0]).toEqual({ runId: 7, fileName: 'rpwdl-index-2026-11-14.json.gz' });
    expect(remembered.at(-1)).toBeNull();
    const stored = db.entries.size;
    expect(stored).toBeGreaterThan(0);
    expect(stored).toBeLessThan(60);
    // second attempt with a healthy network
    const { analysis: a2, run } = await fullImport(text, fakeDbSharing(db));
    expect(a2.plan.total.new).toBe(60 - stored);
    expect(a2.plan.total.unchanged).toBe(stored);
    expect(run.status).toBe('applied');
    expect(db.entries.size).toBe(60);
  });

  it('splits a batch that keeps failing and still delivers every row', async () => {
    const p = Array.from({ length: 8 }, (_, i) => fakePodmiot(i + 1));
    // the first call (8 rows) fails twice (initial + one retry), the halves succeed
    const db = fakeDb({ failEntriesCalls: [1, 2] });
    await fullImport(buildIndex({ p }), db, { startBatch: 100 });
    expect(db.entries.size).toBe(8);
    expect(db.batchSizes).toEqual([4, 4]);
  });

  it('does not retry deterministic errors (CR422)', async () => {
    const p = [fakePodmiot(1)];
    const db = fakeDb({ failEntriesCalls: [1, 2, 3], failWith: () => new CrmError('CR422', 'Nieprawidłowe dane.') });
    const backend = new LocalBackend();
    const analysis = await analyseFile(backend, db.rpc, blobOf(buildIndex({ p })));
    await expect(executeImport(backend, db.rpc, analysis, { sleep: noSleep })).rejects.toMatchObject({ code: 'CR422' });
    expect(db.log.filter((n) => n === 'import_entries')).toHaveLength(1);
  });

  it('cancelling stops between batches and aborts the run', async () => {
    const p = Array.from({ length: 40 }, (_, i) => fakePodmiot(i + 1));
    const db = fakeDb();
    const backend = new LocalBackend();
    const analysis = await analyseFile(backend, db.rpc, blobOf(buildIndex({ p })));
    const ctl = new AbortController();
    await expect(executeImport(backend, db.rpc, analysis, { sleep: noSleep, startBatch: 25, signal: ctl.signal, onProgress: (pr) => { if (pr.phase === 'entries') ctl.abort(); } })).rejects.toBeInstanceOf(ImportCancelled);
    expect(db.log).toContain('import_abort');
    expect(db.log).not.toContain('import_finish');
  });

  it('warns about an older report date, > 10 % gone and database size; blocks above 450 MB', async () => {
    const { p, r } = standardDataset();
    const first = fakeDb();
    await fullImport(buildIndex({ p, r }), first);
    // an older file with only 6 of the podmioty
    const old = fakeDb({
      runs: [{ id: 1, status: 'applied', fileName: 'x', reportDate: '2026-12-01', startedAt: '', finishedAt: '2026-12-01T00:00:00Z', startedBy: 1, counts: null, error: null }],
      bytes: 449 * 1024 * 1024,
    });
    for (const [k, v] of first.entries) old.entries.set(k, v);
    const backend = new LocalBackend();
    const analysis = await analyseFile(backend, old.rpc, blobOf(buildIndex({ p: p.slice(0, 6), r, today: '2026-11-14' })));
    const keys = analysis.warnings.map((w) => w.key).sort();
    expect(keys).toContain('older');
    expect(keys).toContain('gone10');
    const big = fakeDb({ bytes: 460 * 1024 * 1024 });
    const a2 = await analyseFile(new LocalBackend(), big.rpc, blobOf(buildIndex({ p, r })));
    expect(a2.blockers[0]).toMatch(/460 MB/);
    const near = fakeDb({ bytes: 450 * 1024 * 1024 - 10_000 });
    const a3 = await analyseFile(new LocalBackend(), near.rpc, blobOf(buildIndex({ p, r })));
    expect(a3.warnings.map((w) => w.key)).toEqual(['size']);
  });

  it('lists leads with CRM work that the import touches', async () => {
    const { p, r } = standardDataset();
    const first = fakeDb();
    const text = buildIndex({ p, r });
    await fullImport(text, first);
    const hashes = [...first.entries.keys()];
    // second file: drop one podmiot (gone) and change another's e-mail (contact change)
    const p2 = p.filter((_, i) => i !== 12).map((x, i) => (i === 1 ? { ...x, email: 'zmiana@siec-a.example.pl', emails: ['zmiana@siec-a.example.pl'] } : x));
    const second = fakeDb({ crmWork: hashes });
    for (const [k, v] of first.entries) second.entries.set(k, v);
    const analysis = await analyseFile(new LocalBackend(), second.rpc, blobOf(buildIndex({ p: p2, r })));
    expect(analysis.crm.goneTotal).toBe(1);
    expect(analysis.crm.contactTotal).toBe(1);
    expect(analysis.crm.gone).toHaveLength(1);
    expect(analysis.crm.contact).toHaveLength(1);
  });

  it('pages through import_state', async () => {
    const p = Array.from({ length: 5 }, (_, i) => fakePodmiot(i + 1));
    const db = fakeDb();
    const text = buildIndex({ p });
    await fullImport(text, db);
    const calls = db.log.filter((n) => n === 'import_state').length;
    await analyseFile(new LocalBackend(), db.rpc, blobOf(text));
    expect(db.log.filter((n) => n === 'import_state').length).toBeGreaterThan(calls);
  });
});

/** a fresh fake whose database content is that of `other` */
function fakeDbSharing(other: ReturnType<typeof fakeDb>) {
  const db = fakeDb();
  for (const [k, v] of other.entries) db.entries.set(k, v);
  const rpc = (async (name: string, args: Record<string, unknown>) => {
    const res = await (db.rpc as unknown as (n: string, a: Record<string, unknown>) => Promise<unknown>)(name, args);
    if (name === 'import_entries') {
      for (const [k, v] of db.entries) other.entries.set(k, v);
    }
    return res;
  }) as unknown as RpcFn;
  return { ...db, rpc };
}

describe('retry helpers', () => {
  it('withRetry retries network errors twice and gives up', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new CrmError('NETWORK', 'x'); }, noSleep)).rejects.toBeInstanceOf(CrmError);
    expect(calls).toBe(3);
    let n = 0;
    expect(await withRetry(async () => { if (++n < 3) throw new CrmError('UNKNOWN', 'x'); return 'ok'; }, noSleep)).toBe('ok');
  });

  it('withRetry does not retry contract errors', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new CrmError('CR423', 'locked'); }, noSleep)).rejects.toMatchObject({ code: 'CR423' });
    expect(calls).toBe(1);
  });

  it('batch size halves after a slow call and grows after a fast one', () => {
    expect(nextBatchSize(200, 6000)).toBe(100);
    expect(nextBatchSize(30, 6000)).toBe(BATCH_MIN);
    expect(nextBatchSize(200, 500)).toBe(300);
    expect(nextBatchSize(400, 500)).toBe(BATCH_MAX);
    expect(nextBatchSize(200, 3000)).toBe(200);
  });
});
