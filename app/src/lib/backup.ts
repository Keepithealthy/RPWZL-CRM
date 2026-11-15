import { BACKUP_TABLES, CONTRACT_VERSION, EXPORT_PAGE_MAX, type BackupFile, type BackupTable } from './contract';
import { rpc } from './api';

export const BACKUP_PAGE = EXPORT_PAGE_MAX;

export interface BackupProgress { table: BackupTable; tableIndex: number; tableCount: number; rows: number }

/** Builds the whole backup in memory from `backup_export` pages (SPEC 8.3). */
export async function buildBackup(onProgress?: (p: BackupProgress) => void, now: Date = new Date()): Promise<BackupFile> {
  const tables: BackupFile['tables'] = {};
  for (const [i, table] of BACKUP_TABLES.entries()) {
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += BACKUP_PAGE) {
      const page = await rpc('backup_export', { p_table: table, p_offset: offset, p_limit: BACKUP_PAGE });
      rows.push(...page);
      onProgress?.({ table, tableIndex: i, tableCount: BACKUP_TABLES.length, rows: rows.length });
      if (page.length < BACKUP_PAGE) break;
    }
    tables[table] = rows;
  }
  return { format: 'rpwzl-crm-backup', version: 1, createdAt: now.toISOString(), contractVersion: CONTRACT_VERSION, tables };
}

export class BackupFormatError extends Error {}

export function parseBackup(text: string): BackupFile {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new BackupFormatError('To nie jest plik kopii CRM (nie da się go odczytać).');
  }
  const b = v as Partial<BackupFile> | null;
  if (!b || b.format !== 'rpwzl-crm-backup') throw new BackupFormatError('To nie jest plik kopii CRM (zły format).');
  if (b.version !== 1) throw new BackupFormatError(`Nieobsługiwana wersja kopii (${String(b.version)}).`);
  if (!b.tables || typeof b.tables !== 'object') throw new BackupFormatError('Plik kopii jest uszkodzony (brak tabel).');
  return b as BackupFile;
}

export interface RestoreProgress { table: BackupTable; done: number; total: number }
export interface RestoreReport { perTable: Array<{ table: BackupTable; inserted: number; skipped: number; unresolved: number }> }

/** Restore in the contract order (BACKUP_TABLES order is the restore order). */
export async function restoreBackup(file: BackupFile, onProgress?: (p: RestoreProgress) => void): Promise<RestoreReport> {
  const perTable: RestoreReport['perTable'] = [];
  const CHUNK = 500;
  for (const table of BACKUP_TABLES) {
    const rows = file.tables[table] ?? [];
    let inserted = 0, skipped = 0, unresolved = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const r = await rpc('backup_restore', { p_table: table, p_rows: rows.slice(i, i + CHUNK) });
      inserted += r.inserted; skipped += r.skipped; unresolved += r.unresolved;
      onProgress?.({ table, done: Math.min(i + CHUNK, rows.length), total: rows.length });
    }
    perTable.push({ table, inserted, skipped, unresolved });
  }
  return { perTable };
}

export const BACKUP_TABLE_PL: Record<BackupTable, string> = {
  team_member: 'Użytkownicy', lead_status: 'Statusy lejka', tag: 'Tagi', app_setting: 'Ustawienia', lead: 'Leady (status, opiekun, tagi…)',
  lead_contact: 'Kontakty dodane w CRM', activity: 'Historia kontaktów', task: 'Zadania', template: 'Szablony', list: 'Listy',
  list_member: 'Członkowie list', saved_view: 'Widoki', network: 'Sieci', network_member: 'Członkowie sieci',
  val_proposal: 'Propozycje walidacji i decyzje', val_decision: 'Decyzje o kontach', generic_domain: 'Domeny ogólne',
};
