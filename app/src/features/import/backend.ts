/**
 * The import engine seen from the main thread. `WorkerBackend` talks to the Web Worker; `LocalBackend` runs the same
 * engine in-process (unit tests, and a fallback when Workers are unavailable).
 */
import type { DictEntry, ImportBeginInput, ImportDerivedRow, ImportEntryRow, ImportProposalRow, ValDecisions } from '../../lib/contract';
import type { WorkerRequest, WorkerResponse } from '../../workers/import.protocol';
import { ImportEngine, type Phase, type PlanResult, type ProgressFn, type ScanResult } from './engine';
import { ImportError, type BlobLike } from './parse';

export interface ImportBackend {
  init(decisions: ValDecisions | null): Promise<void>;
  scan(file: BlobLike, onProgress?: ProgressFn): Promise<ScanResult>;
  addState(text: string): Promise<number>;
  plan(): Promise<PlanResult>;
  beginInput(fileName: string): Promise<ImportBeginInput>;
  labels(): Promise<DictEntry[]>;
  entries(maxRows: number, maxBytes?: number): Promise<ImportEntryRow[]>;
  derived(max: number): Promise<ImportDerivedRow[]>;
  gone(max: number): Promise<string[]>;
  proposals(max: number): Promise<{ rows: ImportProposalRow[]; last: boolean }>;
  counts(): Promise<{ derived: number; gone: number; proposals: number; entries: number }>;
  dispose(): void;
}

export class LocalBackend implements ImportBackend {
  private engine = new ImportEngine();
  async init(d: ValDecisions | null) { this.engine.setDecisions(d); }
  scan(file: BlobLike, onProgress?: ProgressFn) { return this.engine.scan(file, onProgress); }
  async addState(text: string) { return this.engine.addState(text); }
  async plan() { return this.engine.plan(); }
  async beginInput(fileName: string) { return this.engine.beginInput(fileName); }
  async labels() { return this.engine.labels(); }
  entries(maxRows: number, maxBytes = 4_000_000) { return this.engine.nextEntries(maxRows, maxBytes); }
  async derived(max: number) { return this.engine.nextDerived(max); }
  async gone(max: number) { return this.engine.nextGone(max); }
  async proposals(max: number) { return this.engine.nextProposals(max); }
  async counts() { return this.engine.counts(); }
  dispose() {}
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; onProgress?: (phase: Phase, done: number, total: number) => void };

export class WorkerBackend implements ImportBackend {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(worker?: Worker) {
    this.worker = worker ?? new Worker(new URL('../../workers/import.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if ('type' in m) { p.onProgress?.(m.phase, m.done, m.total); return; }
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(m.error.messagePl ? new ImportError(m.error.messagePl) : new Error(m.error.message));
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'worker error');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private call<T>(req: DistributiveOmit<WorkerRequest, 'id'>, onProgress?: Pending['onProgress']): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  async init(decisions: ValDecisions | null) { await this.call({ type: 'init', decisions }); }
  scan(file: BlobLike, onProgress?: ProgressFn) { return this.call<ScanResult>({ type: 'scan', file: file as Blob }, onProgress); }
  addState(text: string) { return this.call<number>({ type: 'state', text }); }
  plan() { return this.call<PlanResult>({ type: 'plan' }); }
  beginInput(fileName: string) { return this.call<ImportBeginInput>({ type: 'begin-input', fileName }); }
  labels() { return this.call<DictEntry[]>({ type: 'labels' }); }
  entries(maxRows: number, maxBytes = 4_000_000) { return this.call<ImportEntryRow[]>({ type: 'entries', maxRows, maxBytes }); }
  derived(max: number) { return this.call<ImportDerivedRow[]>({ type: 'derived', max }); }
  gone(max: number) { return this.call<string[]>({ type: 'gone', max }); }
  proposals(max: number) { return this.call<{ rows: ImportProposalRow[]; last: boolean }>({ type: 'proposals', max }); }
  counts() { return this.call<{ derived: number; gone: number; proposals: number; entries: number }>({ type: 'counts' }); }
  dispose() {
    this.worker.terminate();
    const err = new Error('worker terminated');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

export function createBackend(): ImportBackend {
  return typeof Worker !== 'undefined' ? new WorkerBackend() : new LocalBackend();
}
