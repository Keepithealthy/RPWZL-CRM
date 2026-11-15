import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest, WorkerResponse } from './import.protocol';
import { WorkerBackend } from '../features/import/backend';
import { MSG_V1 } from '../features/import/parse';
import { buildIndex, standardDataset } from '../features/import/fixtures';

/** Loads the worker module against a fake `self` and returns a Worker-like object wired to it. */
async function fakeWorker() {
  const scope: { onmessage: ((ev: { data: WorkerRequest }) => unknown) | null; postMessage: (m: WorkerResponse) => void } = { onmessage: null, postMessage: () => undefined };
  vi.stubGlobal('self', scope);
  vi.resetModules();
  await import('./import.worker');
  const worker = {
    onmessage: null as ((ev: { data: WorkerResponse }) => void) | null,
    onerror: null,
    postMessage(m: WorkerRequest) { void scope.onmessage?.({ data: m }); },
    terminate() {},
  };
  scope.postMessage = (m) => worker.onmessage?.({ data: m });
  return worker as unknown as Worker;
}

const blobOf = (text: string) => Object.assign(new NodeBlob([text]), { name: 'x.json.gz' }) as unknown as import('../features/import/parse').BlobLike;

afterEach(() => { vi.unstubAllGlobals(); });

describe('import worker protocol', () => {
  it('runs scan, plan and batches through messages', async () => {
    const backend = new WorkerBackend(await fakeWorker());
    const { p, r } = standardDataset();
    await backend.init(null);
    const phases: string[] = [];
    const scan = await backend.scan(blobOf(buildIndex({ p, r })), (phase) => { if (!phases.includes(phase)) phases.push(phase); });
    expect(scan.records).toBe(p.length + r.length);
    expect(phases).toContain('reading');
    expect(phases).toContain('validation');
    expect(await backend.addState('')).toBe(0);
    const plan = await backend.plan();
    expect(plan.total.new).toBe(p.length + r.length);
    const counts = await backend.counts();
    expect(counts.entries).toBe(p.length + r.length);
    const rows = await backend.entries(1000);
    expect(rows).toHaveLength(p.length + r.length);
    expect(await backend.entries(10)).toEqual([]);
    const props = await backend.proposals(1);
    expect(props.rows).toHaveLength(1);
    expect((await backend.labels()).length).toBeGreaterThan(0);
    expect((await backend.beginInput('x.json.gz')).indexVersion).toBe(2);
  });

  it('transfers the Polish message of an ImportError', async () => {
    const backend = new WorkerBackend(await fakeWorker());
    const { p, r } = standardDataset();
    await expect(backend.scan(blobOf(buildIndex({ p, r, version: 1 })))).rejects.toMatchObject({ messagePl: MSG_V1 });
  });

  it('plan before scan is an error, not a hang', async () => {
    const backend = new WorkerBackend(await fakeWorker());
    await expect(backend.plan()).rejects.toThrow(/scan first/);
  });
});
