/**
 * Orchestration of one import (CONTRACT.md 6.1): analyse the file against the database, then, after the owner
 * confirms, send the batches with retry / back-off. Network and the session live here (main thread); parsing and
 * hashing live in the worker (through `ImportBackend`). Nothing here writes CRM tables.
 */
import {
  IMPORT_STATE_PAGE, type ImportRun, type LeadRow, type RpcArgs, type RpcName, type RpcResult,
} from '../../lib/contract';
import { CrmError } from '../../lib/api';
import type { ImportBackend } from './backend';
import type { Phase, PlanResult, ScanResult } from './engine';
import type { BlobLike } from './parse';

export type RpcFn = <N extends RpcName>(name: N, args: RpcArgs<N>) => Promise<RpcResult<N>>;

/** Database size above which an import is refused / needs a confirmation (SPEC 5.4). */
export const DB_REFUSE_BYTES = 450 * 1024 * 1024;
/** Measured average cost of a new register entry (DATA_MODEL 9: 187.6 MB / 264 k entries, plus slack). */
export const EST_BYTES_PER_NEW_ENTRY = 750;
const SAMPLE_SIZE = 50;
const CRM_WORK_CHUNK = 5000;

export interface Warning { key: 'older' | 'gone10' | 'size'; text: string }

export interface Analysis {
  fileName: string;
  scan: ScanResult;
  plan: PlanResult;
  lastRun: { id: number; reportDate: string; finishedAt: string | null } | null;
  db: { bytes: number; limitBytes: number } | null;
  estimatedBytesAfter: number | null;
  /** reasons the import cannot start at all */
  blockers: string[];
  /** reasons that need an explicit tick before "Zatwierdź" */
  warnings: Warning[];
  crm: CrmSample;
}

/** Entries the team works on (CRM work) that the import touches. */
export interface CrmSample {
  goneTotal: number;
  contactTotal: number;
  gone: LeadRow[];
  contact: LeadRow[];
}

export type AnalysisPhase = Phase | 'decisions' | 'finishing-analysis';
export interface AnalysisProgress { phase: AnalysisPhase; done: number; total: number }

const mb = (b: number) => Math.round(b / 1024 / 1024);

export async function analyseFile(
  backend: ImportBackend,
  rpc: RpcFn,
  file: BlobLike & { name?: string },
  onProgress?: (p: AnalysisProgress) => void,
): Promise<Analysis> {
  onProgress?.({ phase: 'decisions', done: 0, total: 1 });
  const decisions = await rpc('val_decisions', {});
  await backend.init(decisions);
  onProgress?.({ phase: 'decisions', done: 1, total: 1 });

  const scan = await backend.scan(file, (phase, done, total) => onProgress?.({ phase, done, total }));

  // the database's current state, page by page
  let after = 0;
  let pages = 0;
  for (;;) {
    onProgress?.({ phase: 'comparing', done: pages * IMPORT_STATE_PAGE, total: 0 });
    const page = await rpc('import_state', { p_after_id: after, p_limit: IMPORT_STATE_PAGE });
    await backend.addState(page.data);
    pages++;
    if (page.nextAfterId === null || page.nextAfterId === undefined) break;
    after = page.nextAfterId;
  }
  const plan = await backend.plan();
  onProgress?.({ phase: 'finishing-analysis', done: 0, total: 1 });

  const [runs, usage] = await Promise.all([
    rpc('import_runs', {}).catch(() => [] as ImportRun[]),
    rpc('db_usage', {}).catch(() => null),
  ]);
  const applied = runs.find((r) => r.status === 'applied') ?? null;
  const lastRun = applied ? { id: applied.id, reportDate: applied.reportDate, finishedAt: applied.finishedAt } : null;
  const db = usage ? { bytes: usage.bytes, limitBytes: usage.limitBytes } : null;
  const estimatedBytesAfter = db ? db.bytes + plan.total.new * EST_BYTES_PER_NEW_ENTRY + plan.total.returned * 100 : null;

  const blockers: string[] = [];
  const warnings: Warning[] = [];
  if (db && db.bytes > DB_REFUSE_BYTES) {
    blockers.push(`Baza zajmuje już ${mb(db.bytes)} MB (próg bezpieczeństwa to ${mb(DB_REFUSE_BYTES)} MB). Najpierw zwolnij miejsce albo przejdź na płatny plan Supabase.`);
  }
  if (lastRun && scan.reportDate < lastRun.reportDate) {
    warnings.push({
      key: 'older',
      text: `Data raportu w pliku (${scan.reportDate}) jest starsza niż w ostatnim imporcie (${lastRun.reportDate}). Wczytujesz starszy plik niż poprzednio.`,
    });
  }
  if (plan.sourcesOver10PercentGone.length > 0) {
    const parts = plan.goneBySource
      .filter((g) => g.share > 0.1)
      .map((g) => `${g.src}: ${g.gone} z ${g.inRegister}`)
      .join(', ');
    warnings.push({ key: 'gone10', text: `Ponad 10% wpisów z jednego źródła zniknęłoby z rejestru (${parts}). Sprawdź, czy plik jest kompletny.` });
  }
  if (estimatedBytesAfter !== null && estimatedBytesAfter > DB_REFUSE_BYTES && !blockers.length) {
    warnings.push({ key: 'size', text: `Po imporcie baza zajmie około ${mb(estimatedBytesAfter)} MB z 500 MB (limit bezpieczeństwa: ${mb(DB_REFUSE_BYTES)} MB).` });
  }

  const crm = await loadCrmSample(rpc, plan.candidates);
  return { fileName: file.name ?? 'indeks.json.gz', scan, plan, lastRun, db, estimatedBytesAfter, blockers, warnings, crm };
}

/** `import_crm_work` is a database addition to the contract (see docs/CONTRACT.md Deviations); a missing function is not fatal. */
type LooseRpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export async function loadCrmSample(rpc: RpcFn, candidates: PlanResult['candidates']): Promise<CrmSample> {
  const empty: CrmSample = { goneTotal: 0, contactTotal: 0, gone: [], contact: [] };
  if (candidates.length === 0) return empty;
  const loose = rpc as unknown as LooseRpc;
  const withWork = new Set<string>();
  try {
    for (let i = 0; i < candidates.length; i += CRM_WORK_CHUNK) {
      const chunk = candidates.slice(i, i + CRM_WORK_CHUNK).map((c) => c.keyHash);
      const res = (await loose('import_crm_work', { p_key_hashes: chunk })) as string[];
      for (const h of res) withWork.add(h);
    }
  } catch {
    return empty;
  }
  const gone = candidates.filter((c) => c.change === 'gone' && withWork.has(c.keyHash));
  const contact = candidates.filter((c) => c.change === 'contact' && withWork.has(c.keyHash));
  const fetchRows = async (list: typeof gone): Promise<LeadRow[]> => {
    if (list.length === 0) return [];
    const ids = list.slice(0, SAMPLE_SIZE).map((c) => c.id);
    try {
      const res = await rpc('leads_search', { p_filter: { entryIds: ids, inRegister: 'all' }, p_sort: null, p_offset: 0, p_limit: SAMPLE_SIZE });
      return res.rows;
    } catch {
      return [];
    }
  };
  return { goneTotal: gone.length, contactTotal: contact.length, gone: await fetchRows(gone), contact: await fetchRows(contact) };
}

/* ------------------------------------------------------------------------------------------------------------------
 * Sending
 * -------------------------------------------------------------------------------------------------------------- */
export interface RunProgress {
  phase: 'start' | 'labels' | 'entries' | 'derived' | 'gone' | 'proposals' | 'finish';
  done: number;
  total: number;
  /** seconds left, or null while unknown */
  etaSec: number | null;
}

export class ImportCancelled extends Error {
  constructor() {
    super('Import przerwany przez użytkownika.');
    this.name = 'ImportCancelled';
  }
}

export interface ExecOptions {
  onProgress?: (p: RunProgress) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** rows per `import_entries` call at the start (max 500) */
  startBatch?: number;
  now?: () => number;
  /** remembers the running run id (survives a page reload so an interrupted run can be aborted) */
  remember?: (run: { runId: number; fileName: string } | null) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const BATCH_MAX = 500;
export const BATCH_MIN = 25;

function retryable(e: unknown): boolean {
  if (e instanceof CrmError) return e.code === 'NETWORK' || e.code === 'UNKNOWN';
  return true;
}

/** Runs `fn`, retrying twice with back-off on network / unknown errors (calls 6-9 of the sequence are idempotent). */
export async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void> = defaultSleep, delays: number[] = [1500, 5000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delays.length || !retryable(e)) throw e;
      await sleep(delays[attempt] as number);
    }
  }
}

/** Sends rows; when a call keeps failing the batch is split in halves (timeouts on a slow database), down to one row. */
async function sendSplitting<R>(rows: R[], send: (rows: R[]) => Promise<void>, sleep: (ms: number) => Promise<void>): Promise<void> {
  try {
    await withRetry(() => send(rows), sleep, [1500]);
  } catch (e) {
    if (rows.length <= 1 || !retryable(e)) throw e;
    const mid = Math.ceil(rows.length / 2);
    await sendSplitting(rows.slice(0, mid), send, sleep);
    await sendSplitting(rows.slice(mid), send, sleep);
  }
}

/** Next batch size: halve after a slow call (> 5 s), grow after a fast one (< 1.5 s). */
export function nextBatchSize(current: number, ms: number): number {
  if (ms > 5000) return Math.max(BATCH_MIN, Math.floor(current / 2));
  if (ms < 1500) return Math.min(BATCH_MAX, Math.ceil(current * 1.5));
  return current;
}

export async function executeImport(backend: ImportBackend, rpc: RpcFn, analysis: Analysis, opts: ExecOptions = {}): Promise<ImportRun> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const check = () => {
    if (opts.signal?.aborted) throw new ImportCancelled();
  };
  const counts = await backend.counts();
  const total = counts.entries + counts.derived + counts.gone + counts.proposals;
  let done = 0;
  const t0 = now();
  const report = (phase: RunProgress['phase']) => {
    const elapsed = (now() - t0) / 1000;
    const eta = done > 0 && elapsed > 3 ? Math.round((elapsed / done) * (total - done)) : null;
    opts.onProgress?.({ phase, done, total, etaSec: eta });
  };

  check();
  report('start');
  const meta = await backend.beginInput(analysis.fileName);
  const { runId } = await rpc('import_begin', { p_meta: meta });
  opts.remember?.({ runId, fileName: analysis.fileName });
  try {
    report('labels');
    const labels = await backend.labels();
    await withRetry(() => rpc('import_labels', { p_run_id: runId, p_labels: labels }), sleep);

    let batch = Math.min(BATCH_MAX, Math.max(BATCH_MIN, opts.startBatch ?? 200));
    for (;;) {
      check();
      const rows = await backend.entries(batch);
      if (rows.length === 0) break;
      const t = now();
      await sendSplitting(rows, async (r) => { await rpc('import_entries', { p_run_id: runId, p_rows: r }); }, sleep);
      batch = nextBatchSize(batch, now() - t);
      done += rows.length;
      report('entries');
    }
    for (;;) {
      check();
      const rows = await backend.derived(2000);
      if (rows.length === 0) break;
      await sendSplitting(rows, async (r) => { await rpc('import_derived', { p_run_id: runId, p_rows: r }); }, sleep);
      done += rows.length;
      report('derived');
    }
    for (;;) {
      check();
      const hashes = await backend.gone(5000);
      if (hashes.length === 0) break;
      await sendSplitting(hashes, async (h) => { await rpc('import_gone', { p_run_id: runId, p_key_hashes: h }); }, sleep);
      done += hashes.length;
      report('gone');
    }
    for (;;) {
      check();
      const { rows, last } = await backend.proposals(1000);
      // the final call (also when there is nothing to send) tells the database which open proposals are stale
      await withRetry(() => rpc('import_proposals', { p_run_id: runId, p_rows: rows, p_final: last }), sleep);
      done += rows.length;
      report('proposals');
      if (last) break;
    }
    check();
    report('finish');
    const run = await withRetry(() => rpc('import_finish', { p_run_id: runId, p_counts: analysis.plan.total }), sleep);
    opts.remember?.(null);
    return run;
  } catch (e) {
    const reason = e instanceof ImportCancelled ? 'cancelled by the owner' : `error: ${(e as Error)?.message ?? String(e)}`;
    try {
      await rpc('import_abort', { p_run_id: runId, p_reason: reason.slice(0, 500) });
    } catch {
      /* the run is superseded automatically after 2 hours */
    }
    opts.remember?.(null);
    throw e;
  }
}

/* ------------------------------------------------------------------------------------------------------------------
 * Remembering an interrupted run (per browser; only a convenience)
 * -------------------------------------------------------------------------------------------------------------- */
const RUN_KEY = 'rpwzl.import.run';
export interface RememberedRun { runId: number; fileName: string; startedAt: string }

export function rememberRun(run: { runId: number; fileName: string } | null): void {
  try {
    if (run) localStorage.setItem(RUN_KEY, JSON.stringify({ ...run, startedAt: new Date().toISOString() }));
    else localStorage.removeItem(RUN_KEY);
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

export function recalledRun(): RememberedRun | null {
  try {
    const raw = localStorage.getItem(RUN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as RememberedRun;
    return typeof v.runId === 'number' ? v : null;
  } catch {
    return null;
  }
}
