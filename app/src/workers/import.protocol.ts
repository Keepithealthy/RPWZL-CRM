/** Messages between the main thread and the import worker. Requests carry an `id`; the worker answers with the same id. */
import type { DictEntry, ImportBeginInput, ImportDerivedRow, ImportEntryRow, ImportProposalRow, ValDecisions } from '../lib/contract';
import type { Phase, PlanResult, ScanResult } from '../features/import/engine';

export type WorkerRequest =
  | { id: number; type: 'init'; decisions: ValDecisions | null }
  | { id: number; type: 'scan'; file: Blob & { name?: string } }
  | { id: number; type: 'state'; text: string }
  | { id: number; type: 'plan' }
  | { id: number; type: 'begin-input'; fileName: string }
  | { id: number; type: 'labels' }
  | { id: number; type: 'entries'; maxRows: number; maxBytes: number }
  | { id: number; type: 'derived'; max: number }
  | { id: number; type: 'gone'; max: number }
  | { id: number; type: 'proposals'; max: number }
  | { id: number; type: 'counts' };

export type WorkerResult = {
  init: null;
  scan: ScanResult;
  state: number;
  plan: PlanResult;
  'begin-input': ImportBeginInput;
  labels: DictEntry[];
  entries: ImportEntryRow[];
  derived: ImportDerivedRow[];
  gone: string[];
  proposals: { rows: ImportProposalRow[]; last: boolean };
  counts: { derived: number; gone: number; proposals: number; entries: number };
};

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; messagePl?: string } }
  | { type: 'progress'; id: number; phase: Phase; done: number; total: number };
