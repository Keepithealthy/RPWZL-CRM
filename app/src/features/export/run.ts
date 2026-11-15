import { EXPORT_PAGE_MAX, type BulkTarget, type ExportFormat, type ExportOptions, type ExportRow, type LeadFilter } from '../../lib/contract';
import { rpc } from '../../lib/api';

export interface FetchProgress { done: number; total: number }

/** export_begin + export_page batches. The file itself is built in the browser (SPEC 4.11). */
export async function fetchExportRows(
  target: BulkTarget,
  format: ExportFormat,
  options: ExportOptions,
  onProgress?: (p: FetchProgress) => void,
  isCancelled?: () => boolean,
): Promise<ExportRow[]> {
  const { exportId, total } = await rpc('export_begin', { p_target: target, p_format: format, p_options: options });
  const rows: ExportRow[] = [];
  for (let offset = 0; offset < total; offset += EXPORT_PAGE_MAX) {
    if (isCancelled?.()) break;
    const page = await rpc('export_page', { p_export_id: exportId, p_offset: offset, p_limit: EXPORT_PAGE_MAX });
    rows.push(...page);
    onProgress?.({ done: rows.length, total });
    if (page.length === 0) break;
  }
  return rows;
}

/** How many selected leads are left out because of "nie kontaktować" (the server excludes them unless includeDnc). */
export async function countDnc(target: BulkTarget): Promise<number> {
  const base: LeadFilter = 'filter' in target ? target.filter : { entryIds: target.entryIds, inRegister: 'all' };
  const res = await rpc('leads_count', { p_filter: { ...base, dnc: 'only' } });
  return res.total;
}
