import { describe, expect, it } from 'vitest';
import type { LeadFilter } from './contract';
import { cleanFilter, decodeFilter, encodeFilter, sameFilter } from './filterCodec';

describe('filter codec', () => {
  it('round-trips unicode through base64url', () => {
    const f: LeadFilter = { kind: 'p', miasto: 'Łódź', sel: { 'p.grp': ['0'] }, spec1Min: 5 };
    const s = encodeFilter(f);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFilter(s)).toEqual(f);
  });
  it('returns null for garbage', () => {
    expect(decodeFilter('%%%')).toBeNull();
    expect(decodeFilter('')).toBeNull();
    expect(decodeFilter(btoa('[1,2]'))).toBeNull();
  });
  it('drops empty values and defaults', () => {
    expect(cleanFilter({ kind: 'all', q: '', sel: { 'p.dz': [] }, contact: { email: false }, inRegister: 'yes', dnc: 'all' })).toEqual({});
    expect(cleanFilter({ contact: { email: true, tel: false } })).toEqual({ contact: { email: true } });
  });
  it('compares filters regardless of key order and empties', () => {
    expect(sameFilter({ kind: 'p', q: 'a' }, { q: 'a', kind: 'p', tags: [] })).toBe(true);
    expect(sameFilter({ kind: 'p' }, { kind: 'r' })).toBe(false);
  });
});
