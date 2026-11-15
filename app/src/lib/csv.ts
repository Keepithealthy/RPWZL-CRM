import { ENTITY_TYPE, SOURCE_LABEL_PL, VALIDATION, type ExportRow, type SourceId } from './contract';
import { tidyName } from './template';
import { emailQuality, isValidEmail, normalizeEmail, wwwQuality } from '../features/validation/rules';

/* ---------------------------------------------------------------------------------------------------------------
 * Generic CSV (SPEC 8.1) and Customer.io People CSV (SPEC 8.2). Pure functions: rows in, text out.
 * ------------------------------------------------------------------------------------------------------------- */

/** Spreadsheet formula guard: a cell starting with = + - @ TAB CR gets a leading apostrophe. */
export function guardFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** RFC 4180 quoting. */
export function csvCell(value: string, sep: string): string {
  if (value.includes('"') || value.includes(sep) || /[\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function csvLine(cells: string[], sep: string): string {
  return cells.map((c) => csvCell(c, sep)).join(sep);
}

export const BOM = '﻿';

/* ------------------------------------------------ generic CSV ---------------------------------------------- */

export interface CsvColumn { key: string; header: string; always?: boolean; get: (r: ExportRow, extra: DedupeExtra) => string }
export interface DedupeExtra { otherEmails: string[]; otherPhones: string[] }

const ENTITY_SLUG: Record<number, string> = {
  [ENTITY_TYPE.PODMIOT_PRAWNY]: 'podmiot_prawny', [ENTITY_TYPE.JDG]: 'jdg', [ENTITY_TYPE.PUBLICZNY]: 'publiczny',
  [ENTITY_TYPE.PRAKTYKA_IND]: 'praktyka_indywidualna', [ENTITY_TYPE.PRAKTYKA_GRUP]: 'praktyka_grupowa',
};
const ENTITY_LABEL: Record<number, string> = {
  1: 'Spółka / podmiot prawny', 2: 'JDG', 3: 'Podmiot publiczny', 4: 'Praktyka indywidualna', 5: 'Praktyka grupowa',
};
const VALIDATION_SLUG = ['niezweryfikowany', 'do_sprawdzenia', 'zweryfikowany', 'odrzucony'];
const VALIDATION_LABEL = ['Niezweryfikowany', 'Do sprawdzenia', 'Zweryfikowany', 'Odrzucony'];

const num = (n: number | null) => (n === null || n === undefined ? '' : String(n));
const mobile48 = (r: ExportRow) => (r.mobile ? `48${r.mobile}` : '');

export const CSV_COLUMNS: CsvColumn[] = [
  { key: 'name', header: 'Nazwa', always: true, get: (r) => tidyName(r.name) },
  { key: 'email', header: 'E-mail', always: true, get: (r) => r.email ?? '' },
  { key: 'tel', header: 'Telefon', always: true, get: (r) => r.tel ?? '' },
  { key: 'nip', header: 'NIP', always: true, get: (r) => r.nip ?? '' },
  { key: 'miasto', header: 'Miejscowość', always: true, get: (r) => r.miasto ?? '' },
  { key: 'mobile', header: 'Telefon komórkowy', get: mobile48 },
  { key: 'www', header: 'WWW', get: (r) => r.www ?? '' },
  { key: 'woj', header: 'Województwo', get: (r) => r.woj ?? '' },
  { key: 'ulica', header: 'Ulica', get: (r) => r.ulica ?? '' },
  { key: 'kod', header: 'Kod pocztowy', get: (r) => r.kod ?? '' },
  { key: 'src', header: 'Źródło', get: (r) => SOURCE_LABEL_PL[r.src] ?? r.src },
  { key: 'entity', header: 'Typ podmiotu', get: (r) => ENTITY_LABEL[r.entityType] ?? '' },
  { key: 'forma', header: 'Forma prawna', get: (r) => r.forma ?? '' },
  { key: 'status', header: 'Status', get: (r) => r.status },
  { key: 'owner', header: 'Opiekun', get: (r) => r.owner ?? '' },
  { key: 'tags', header: 'Tagi', get: (r) => r.tags.join(', ') },
  { key: 'validation', header: 'Status walidacji', get: (r) => VALIDATION_LABEL[r.validation] ?? '' },
  { key: 'next', header: 'Następny krok', get: (r) => r.nextStepAt ?? '' },
  { key: 'last', header: 'Ostatni kontakt', get: (r) => (r.lastContactAt ?? '').slice(0, 10) },
  { key: 'wpis', header: 'Data wpisu', get: (r) => r.wpis ?? '' },
  { key: 'stan', header: 'Ostatnia zmiana wpisu', get: (r) => r.stan ?? '' },
  { key: 'spec1', header: 'Poradnie specjalistyczne', get: (r) => num(r.spec1) },
  { key: 'nz', header: 'Zakłady', get: (r) => num(r.nz) },
  { key: 'nk', header: 'Komórki', get: (r) => num(r.nk) },
  { key: 'otherEmails', header: 'Inne e-maile', get: (r, x) => unique([...r.emails.filter((e) => e !== r.email), ...x.otherEmails]).slice(0, 20).join(', ') },
  { key: 'otherPhones', header: 'Inne telefony', get: (r, x) => unique([...r.phones.filter((p) => p !== r.tel), ...x.otherPhones]).slice(0, 20).join(', ') },
  { key: 'dnc', header: 'Nie kontaktować', get: (r) => (r.dnc ? 'tak' : '') },
  { key: 'regKey', header: 'Klucz rejestru', get: (r) => r.regKey },
  { key: 'crmId', header: 'ID CRM', get: (r) => r.keyHash },
];

export const CSV_DEFAULT_OPTIONAL = ['mobile', 'www', 'woj', 'src', 'status', 'owner', 'tags', 'validation', 'regKey', 'crmId'];

function unique<T>(a: T[]): T[] {
  return [...new Set(a)];
}

/** Score used to pick the winner among duplicates: 4*tel + 2*email + 1*www, ties -> lowest id. */
export function contactScore(r: ExportRow): number {
  return (r.tel ? 4 : 0) + (r.email ? 2 : 0) + (r.www ? 1 : 0);
}

export interface DedupeStats { kept: number; merged: number; noKeyKept: number }

export interface Deduped { rows: Array<{ row: ExportRow; extra: DedupeExtra }>; merged: number }

const emptyExtra = (): DedupeExtra => ({ otherEmails: [], otherPhones: [] });

function better(a: ExportRow, b: ExportRow): boolean {
  const sa = contactScore(a);
  const sb = contactScore(b);
  return sa !== sb ? sa > sb : a.id < b.id;
}

/** Dedupe by NIP (rows without a usable NIP are never merged) or by normalised e-mail. Contacts of losers are merged into the winner. */
export function dedupeRows(rows: ExportRow[], by: 'none' | 'nip' | 'email'): Deduped {
  if (by === 'none') return { rows: rows.map((row) => ({ row, extra: emptyExtra() })), merged: 0 };
  const groups = new Map<string, { win: ExportRow; extra: DedupeExtra }>();
  const out: Array<{ row: ExportRow; extra: DedupeExtra } | { groupKey: string }> = [];
  let merged = 0;
  for (const r of rows) {
    const key = by === 'nip' ? (/^\d{10}$/.test(r.nip ?? '') && !/^(\d)\1{9}$/.test(r.nip ?? '') ? `n:${r.nip}` : null) : r.email ? `e:${r.email.trim().toLowerCase()}` : null;
    if (!key) {
      out.push({ row: r, extra: emptyExtra() });
      continue;
    }
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { win: r, extra: emptyExtra() });
      out.push({ groupKey: key });
      continue;
    }
    merged++;
    const [winner, loser] = better(r, g.win) ? [r, g.win] : [g.win, r];
    g.win = winner;
    g.extra.otherEmails.push(...loser.emails, ...(loser.email ? [loser.email] : []));
    g.extra.otherPhones.push(...loser.phones, ...(loser.tel ? [loser.tel] : []));
  }
  const final = out.map((o) => {
    if ('groupKey' in o) {
      const g = groups.get(o.groupKey)!;
      return { row: g.win, extra: g.extra };
    }
    return o;
  });
  return { rows: final, merged };
}

export interface CsvOptions { separator: ';' | ','; bom: boolean; optionalColumns: string[] }

export function buildGenericCsv(rows: Array<{ row: ExportRow; extra: DedupeExtra }>, opts: CsvOptions): string {
  const cols = CSV_COLUMNS.filter((c) => c.always || opts.optionalColumns.includes(c.key));
  const lines = [csvLine(cols.map((c) => c.header), opts.separator)];
  for (const { row, extra } of rows) lines.push(csvLine(cols.map((c) => guardFormula(c.get(row, extra))), opts.separator));
  return (opts.bom ? BOM : '') + lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------ Customer.io ---------------------------------------------- */

export const CUSTOMERIO_HEADERS = [
  'id', 'email', 'created_at', 'name', 'short_name', 'city', 'voivodeship', 'postal_code', 'street', 'nip', 'sms_phone',
  'phone_raw', 'website', 'source', 'entity_type', 'legal_form', 'form_type', 'crm_status', 'crm_owner', 'crm_tags',
  'validation_status', 'email_quality', 'register_entry_date', 'register_last_change', 'specialist_clinics', 'units',
  'cells', 'in_register', 'lead_ids',
] as const;

export interface CustomerioOptions { identifier: 'email' | 'id'; includePhoneColumn: boolean }

/** Unix seconds, or '' for no / unparseable date and for dates before 1970: Customer.io's parsing of negative timestamps
 *  is not documented, so those cells stay empty (RDV-6, CONTRACT 8 item 70). */
export function unixSeconds(dateOrTs: string | null | undefined): string {
  if (!dateOrTs) return '';
  const t = /^\d{4}-\d{2}-\d{2}$/.test(dateOrTs) ? Date.parse(`${dateOrTs}T00:00:00Z`) : Date.parse(dateOrTs);
  return Number.isNaN(t) || t < 0 ? '' : String(Math.floor(t / 1000));
}

/**
 * The address written to Customer.io's `email` column (SPEC 8.2, RFC 5322): the row's best e-mail when valid, else (a register
 * cell can hold 'a@x.pl, b@y.pl') its first valid part or the first valid address of `emails`, lower-cased; '' when the row has
 * no best e-mail or none of these is valid (RDV-2).
 */
export function customerioEmail(r: Pick<ExportRow, 'email' | 'emails'>): string {
  if (!r.email) return '';
  const candidates = [r.email, ...r.email.split(/[,;\s]+/), ...r.emails];
  for (const c of candidates) {
    const e = normalizeEmail(c);
    if (e && isValidEmail(e)) return e;
  }
  return '';
}

/**
 * `email_quality` for the address that is actually exported. The stored q_email is the best score among all of the entry's
 * addresses, but the export writes one address (customerioEmail), so the score is capped by that address's own quality (no
 * sharing or staleness information is available here, so only syntax, domain class and role count): an entry whose exported
 * address is on a typo domain never carries the quality of another, better address.
 */
export function customerioEmailQuality(r: Pick<ExportRow, 'email' | 'emails' | 'qEmail'>): number | null {
  const e = customerioEmail(r);
  if (!e) return r.qEmail;
  const own = emailQuality(e, 1, false);
  return r.qEmail === null ? own : Math.min(r.qEmail, own);
}

/** Customer.io `website`: the normalised host of the WWW field (no scheme, `www.`, path; lower case), or '' when the field
 *  is invalid or a social / portal host. A field listing several sites gives the first valid one (RDV-1). */
export function customerioWebsite(raw: string | null | undefined): string {
  if (!raw) return '';
  const whole = wwwQuality(raw);
  if (whole.status === 'ok' && whole.host) return whole.host;
  if (whole.status === 'social') return '';
  for (const part of raw.split(/[,;\s]+/)) {
    const w = wwwQuality(part);
    if (w.status === 'ok' && w.host) return w.host;
  }
  return '';
}

export interface CustomerioRowExtra { leadIds: string[] }

function formType(r: ExportRow): string {
  return r.formType ?? '';
}

/** Winner among rows sharing an e-mail: highest email quality, then podmiot before practice, then lowest id (SPEC 8.2). */
export function customerioWinner(a: ExportRow, b: ExportRow): ExportRow {
  const qa = customerioEmailQuality(a) ?? -1;
  const qb = customerioEmailQuality(b) ?? -1;
  if (qa !== qb) return qa > qb ? a : b;
  if (a.kind !== b.kind) return a.kind === 'p' ? a : b;
  return a.id <= b.id ? a : b;
}

export interface CustomerioPrepared { rows: Array<{ row: ExportRow; leadIds: string[] }>; skippedNoEmail: number; skippedDuplicates: number }

export function prepareCustomerio(rows: ExportRow[], opts: CustomerioOptions): CustomerioPrepared {
  if (opts.identifier === 'id') {
    return { rows: rows.map((row) => ({ row, leadIds: [] })), skippedNoEmail: 0, skippedDuplicates: 0 };
  }
  const groups = new Map<string, { win: ExportRow; others: ExportRow[] }>();
  const order: string[] = [];
  let noEmail = 0;
  for (const r of rows) {
    const e = customerioEmail(r);
    if (!e) {
      noEmail++;
      continue;
    }
    const g = groups.get(e);
    if (!g) {
      groups.set(e, { win: r, others: [] });
      order.push(e);
    } else {
      const w = customerioWinner(g.win, r);
      g.others.push(w === g.win ? r : g.win);
      g.win = w;
    }
  }
  let dup = 0;
  const out = order.map((e) => {
    const g = groups.get(e)!;
    dup += g.others.length;
    return { row: g.win, leadIds: g.others.map((o) => `rpwdl-${o.keyHash}`) };
  });
  return { rows: out, skippedNoEmail: noEmail, skippedDuplicates: dup };
}

export function buildCustomerioCsv(prepared: Array<{ row: ExportRow; leadIds: string[] }>, opts: CustomerioOptions): string {
  const headers: string[] = [...CUSTOMERIO_HEADERS];
  if (opts.includePhoneColumn) headers.splice(2, 0, 'phone');
  const lines = [csvLine(headers, ',')];
  for (const { row: r, leadIds } of prepared) {
    const smsPhone = r.mobile ? `+48${r.mobile}` : '';
    const cells: Record<string, string> = {
      id: `rpwdl-${r.keyHash}`,
      email: customerioEmail(r),
      phone: smsPhone,
      created_at: unixSeconds(r.firstImportedAt),
      name: tidyName(r.name),
      short_name: tidyName(r.shortName) || tidyName(r.name),
      city: r.miasto ?? '',
      voivodeship: r.woj ?? '',
      postal_code: r.kod ?? '',
      street: r.ulica ?? '',
      nip: (r.nip ?? '').replace(/\D/g, ''),
      sms_phone: opts.includePhoneColumn ? '' : smsPhone,
      phone_raw: r.tel ?? '',
      website: customerioWebsite(r.www),
      source: SOURCE_LABEL_PL[r.src as SourceId] ?? r.src,
      entity_type: ENTITY_SLUG[r.entityType] ?? '',
      legal_form: r.forma ?? '',
      form_type: formType(r),
      crm_status: r.status,
      crm_owner: r.owner ?? '',
      crm_tags: r.tags.join('|'),
      validation_status: VALIDATION_SLUG[r.validation] ?? VALIDATION_SLUG[VALIDATION.NIEZWERYFIKOWANY]!,
      email_quality: num(customerioEmailQuality(r)),
      register_entry_date: unixSeconds(r.wpis),
      register_last_change: unixSeconds(r.stan),
      specialist_clinics: num(r.spec1),
      units: num(r.nz),
      cells: num(r.nk),
      in_register: r.inRegister ? 'true' : 'false',
      lead_ids: leadIds.join('|'),
    };
    lines.push(csvLine(headers.map((h) => cells[h] ?? ''), ','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** File name `rpwzl-<label slug (≤ 40, cut at a word boundary)>[-<suffix>]-<date>.<ext>`; the label is shortened before the
 *  suffix is added, so a long view name never cuts the suffix (RDV-5). */
export function exportFileName(label: string, ext: 'csv', date: string, suffix = ''): string {
  const full = label
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  let slug = full.slice(0, 40);
  // a long label is cut at a word boundary when there is one
  if (full.length > 40 && full[40] !== '-' && slug.includes('-')) slug = slug.slice(0, slug.lastIndexOf('-'));
  slug = slug.replace(/-+$/, '') || 'leady';
  return `rpwzl-${slug}${suffix ? `-${suffix}` : ''}-${date}.${ext}`;
}
