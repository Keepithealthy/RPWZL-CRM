import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_TABLES } from './contract';

const rpcMock = vi.fn();
vi.mock('./supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) }, supabaseConfigured: true }));

import { BackupFormatError, buildBackup, parseBackup, restoreBackup } from './backup';

describe('backup', () => {
  beforeEach(() => { rpcMock.mockReset(); });

  it('pages every table until a short page', async () => {
    const calls: Array<[string, number]> = [];
    rpcMock.mockImplementation((...call: unknown[]) => {
      const args = call[1] as { p_table: string; p_offset: number };
      calls.push([args.p_table, args.p_offset]);
      const rows = args.p_table === 'activity' ? (args.p_offset === 0 ? Array.from({ length: 5000 }, (_, i) => ({ n: i })) : [{ n: 5000 }]) : [];
      return Promise.resolve({ data: rows, error: null });
    });
    const file = await buildBackup(undefined, new Date('2026-11-15T10:00:00Z'));
    expect(file.format).toBe('rpwzl-crm-backup');
    expect(file.createdAt).toBe('2026-11-15T10:00:00.000Z');
    expect(Object.keys(file.tables)).toEqual([...BACKUP_TABLES]);
    expect(file.tables.activity).toHaveLength(5001);
    expect(calls.filter(([t]) => t === 'activity').map(([, o]) => o)).toEqual([0, 5000]);
  });

  it('validates the file format', () => {
    expect(() => parseBackup('not json')).toThrow(BackupFormatError);
    expect(() => parseBackup('{"format":"other"}')).toThrow(/zły format/);
    expect(() => parseBackup('{"format":"rpwzl-crm-backup","version":2,"tables":{}}')).toThrow(/Nieobsługiwana/);
    expect(parseBackup('{"format":"rpwzl-crm-backup","version":1,"tables":{}}').version).toBe(1);
  });

  it('restores in contract order, in chunks, and sums the report', async () => {
    const order: string[] = [];
    rpcMock.mockImplementation((...call: unknown[]) => {
      const a = call[1] as { p_table: string; p_rows: unknown[] };
      order.push(`${a.p_table}:${a.p_rows.length}`);
      return Promise.resolve({ data: { inserted: a.p_rows.length, skipped: 1, unresolved: 0 }, error: null });
    });
    const report = await restoreBackup({ format: 'rpwzl-crm-backup', version: 1, createdAt: '', contractVersion: 1, tables: { tag: [{ name: 'a' }], lead: Array.from({ length: 1200 }, () => ({})) } });
    expect(order).toEqual(['tag:1', 'lead:500', 'lead:500', 'lead:200']);
    expect(report.perTable.find((t) => t.table === 'lead')).toEqual({ table: 'lead', inserted: 1200, skipped: 3, unresolved: 0 });
    expect(report.perTable.map((t) => t.table)).toEqual([...BACKUP_TABLES]);
  });
});
