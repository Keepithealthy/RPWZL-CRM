/// <reference lib="webworker" />
/**
 * Import Web Worker: parses the index file (streaming gunzip), hashes and validates it and prepares batches. It holds
 * the light per-entry records; the main thread owns the network (session, retries) and pulls batches one at a time.
 */
import { ImportEngine } from '../features/import/engine';
import { ImportError } from '../features/import/parse';
import type { WorkerRequest, WorkerResponse } from './import.protocol';

const engine = new ImportEngine();
const post = (m: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const m = ev.data;
  try {
    let result: unknown = null;
    switch (m.type) {
      case 'init':
        engine.setDecisions(m.decisions);
        break;
      case 'scan':
        result = await engine.scan(m.file, (phase, done, total) => post({ type: 'progress', id: m.id, phase, done, total }));
        break;
      case 'state':
        result = engine.addState(m.text);
        break;
      case 'plan':
        result = engine.plan();
        break;
      case 'begin-input':
        result = engine.beginInput(m.fileName);
        break;
      case 'labels':
        result = engine.labels();
        break;
      case 'entries':
        result = await engine.nextEntries(m.maxRows, m.maxBytes);
        break;
      case 'derived':
        result = engine.nextDerived(m.max);
        break;
      case 'gone':
        result = engine.nextGone(m.max);
        break;
      case 'proposals':
        result = engine.nextProposals(m.max);
        break;
      case 'counts':
        result = engine.counts();
        break;
    }
    post({ id: m.id, ok: true, result });
  } catch (e) {
    const err = e as Error;
    post({ id: m.id, ok: false, error: { message: String(err?.message ?? e), messagePl: e instanceof ImportError ? e.messagePl : undefined } });
  }
};
