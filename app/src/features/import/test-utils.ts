/** Test helpers: a tiny in-memory stand-in for the database's import RPCs (not used by the app). */
import type { DictEntry, ImportEntryRow, ImportProposalRow, ImportRun } from '../../lib/contract';
import { CrmError } from '../../lib/api';
import type { RpcFn } from './run';

interface Stored { id: number; keyHash: string; hAll: string; hContact: string; hDerived: string; inRegister: boolean; src: number }

/** A tiny in-memory stand-in for the import RPCs of the database. */
export function fakeDb(opts: { failEntriesCalls?: number[]; failWith?: () => Error; bytes?: number; runs?: ImportRun[]; crmWork?: string[] } = {}) {
  const entries = new Map<string, Stored>();
  const log: string[] = [];
  const proposals: ImportProposalRow[][] = [];
  const finals: boolean[] = [];
  let labels: DictEntry[] = [];
  let nextId = 1;
  let entriesCalls = 0;
  const batchSizes: number[] = [];
  const runs: ImportRun[] = opts.runs ?? [];
  const goneHashes: string[] = [];

  const rpc = (async (name: string, args: Record<string, unknown>) => {
    log.push(name);
    switch (name) {
      case 'ref_data':
        return { members: [{ id: 1, displayName: 'Właściciel', role: 'owner', active: true, phone: null, email: 'o@example.test' }], statuses: [], tags: [], views: [], lists: [], lastImport: null, settings: {}, me: { memberId: 1 } };
      case 'val_decisions':
        return { detach: [], attach: [], genericDomains: [], decidedProposals: [], params: undefined };
      case 'import_state': {
        const all = [...entries.values()].sort((a, b) => a.id - b.id).filter((e) => e.id > (args.p_after_id as number));
        const page = all.slice(0, args.p_limit as number);
        const data = page.map((e) => [e.id, e.keyHash, e.hAll, e.hContact, e.hDerived, e.inRegister ? 1 : 0, e.src].join('\t')).join('\n');
        return { data, nextAfterId: page.length === args.p_limit ? page[page.length - 1]!.id : null };
      }
      case 'import_runs':
        return runs;
      case 'db_usage':
        return { bytes: opts.bytes ?? 50 * 1024 * 1024, limitBytes: 500 * 1024 * 1024, tables: [] };
      case 'import_crm_work':
        return (args.p_key_hashes as string[]).filter((h) => (opts.crmWork ?? []).includes(h));
      case 'leads_search':
        return { rows: ((args.p_filter as { entryIds: number[] }).entryIds).map((id) => ({ id, name: `Lead ${id}` })) };
      case 'import_begin':
        return { runId: 7 };
      case 'import_labels':
        labels = args.p_labels as DictEntry[];
        return { upserted: labels.length };
      case 'import_entries': {
        entriesCalls++;
        if (opts.failEntriesCalls?.includes(entriesCalls)) throw (opts.failWith ?? (() => new CrmError('NETWORK', 'offline')))();
        const rows = args.p_rows as ImportEntryRow[];
        batchSizes.push(rows.length);
        for (const r of rows) {
          const prev = entries.get(r.keyHash);
          entries.set(r.keyHash, {
            id: prev?.id ?? nextId++, keyHash: r.keyHash, hAll: r.hAll, hContact: r.hContact, hDerived: r.hDerived, inRegister: true,
            src: r.kind === 'p' ? 0 : 1,
          });
        }
        return { inserted: rows.length, updated: 0, returned: 0 };
      }
      case 'import_derived':
        return { updated: (args.p_rows as unknown[]).length };
      case 'import_gone':
        goneHashes.push(...(args.p_key_hashes as string[]));
        return { gone: (args.p_key_hashes as unknown[]).length };
      case 'import_proposals':
        proposals.push(args.p_rows as ImportProposalRow[]);
        finals.push(args.p_final as boolean);
        return { upserted: 0, reopened: 0, staled: 0 };
      case 'import_finish':
        return { id: 7, status: 'applied', fileName: 'x', reportDate: '2026-11-14', startedAt: '', finishedAt: '', startedBy: 1, counts: args.p_counts, error: null };
      case 'import_abort':
        return { id: 7, status: 'aborted' };
      default:
        throw new Error('unmocked ' + name);
    }
  }) as unknown as RpcFn;
  return { rpc, entries, log, proposals, finals, labels: () => labels, batchSizes, goneHashes };
}

