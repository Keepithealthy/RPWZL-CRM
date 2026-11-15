import { describe, expect, it } from 'vitest';
import { CFLAG, ERR, ERROR_TEXT_PL, MEMBER_RPCS, QFLAG, QFLAG_PROBLEM_MASK, SOURCES } from './contract';

describe('contract constants', () => {
  it('uses distinct single bits for QFLAG and CFLAG', () => {
    for (const flags of [Object.values(QFLAG), Object.values(CFLAG)]) {
      expect(new Set(flags).size).toBe(flags.length);
      for (const f of flags) expect(f & (f - 1)).toBe(0);
    }
    expect(QFLAG_PROBLEM_MASK & QFLAG.EMAIL_FREE).toBe(0);
  });
  it('has Polish text for every error code', () => {
    for (const code of Object.values(ERR)) expect(ERROR_TEXT_PL[code]).toBeTruthy();
  });
  it('keeps the source order of the offline tool', () => {
    expect(SOURCES[0]).toBe('Rpm');
    expect(SOURCES).toHaveLength(9);
  });
  it('never lets members import, export or back up', () => {
    expect(MEMBER_RPCS.some((n) => n.startsWith('import_') || n.startsWith('export_') || n.startsWith('backup_'))).toBe(false);
  });
});
