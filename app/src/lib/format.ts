/** Polish formatting helpers (SPEC 4.1): numbers `27 167`, dates `dd.mm.rrrr`, plurals. */

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const neg = n < 0;
  const s = Math.trunc(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + s;
}

/** 'YYYY-MM-DD…' -> 'dd.mm.rrrr' without any timezone conversion. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** plural(1,'rekord','rekordy','rekordów') */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n);
  if (a === 1) return one;
  const last = a % 10;
  const lastTwo = a % 100;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

export function countPl(n: number, one: string, few: string, many: string): string {
  return `${fmtNum(n)} ${plural(n, one, few, many)}`;
}

export const leadsPl = (n: number) => countPl(n, 'lead', 'leady', 'leadów');

/** Local calendar date as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function addDaysIso(days: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return todayIso(d);
}

export function addMonthsIso(months: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() + months, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(now.getDate(), last));
  return todayIso(d);
}

export function daysSince(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const a = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86_400_000);
}
