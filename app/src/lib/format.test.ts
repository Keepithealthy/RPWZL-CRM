import { describe, expect, it } from 'vitest';
import { addDaysIso, addMonthsIso, countPl, daysSince, fmtDate, fmtNum, plural, todayIso } from './format';

describe('format', () => {
  it('groups thousands with a no-break space', () => {
    expect(fmtNum(27167)).toBe('27 167');
    expect(fmtNum(8167)).toBe('8 167');
    expect(fmtNum(12)).toBe('12');
    expect(fmtNum(null)).toBe('–');
  });
  it('formats dates dd.mm.rrrr without timezone shifts', () => {
    expect(fmtDate('2026-11-14')).toBe('14.11.2026');
    expect(fmtDate('2026-11-14T23:30:00-05:00')).toBe('14.11.2026');
    expect(fmtDate(null)).toBe('–');
  });
  it('uses Polish plurals', () => {
    const f = (n: number) => plural(n, 'rekord', 'rekordy', 'rekordów');
    expect([0, 1, 2, 4, 5, 12, 14, 22, 25, 112].map(f)).toEqual(['rekordów', 'rekord', 'rekordy', 'rekordy', 'rekordów', 'rekordów', 'rekordów', 'rekordy', 'rekordów', 'rekordów']);
    expect(countPl(1240, 'lead', 'leady', 'leadów')).toBe('1 240 leadów');
  });
  it('does date arithmetic in local calendar days', () => {
    const now = new Date(2026, 0, 31);
    expect(todayIso(now)).toBe('2026-01-31');
    expect(addDaysIso(1, now)).toBe('2026-02-01');
    expect(addMonthsIso(1, now)).toBe('2026-02-28');
    expect(daysSince('2026-01-01', now)).toBe(30);
  });
});
