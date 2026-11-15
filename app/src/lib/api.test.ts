import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
vi.mock('./supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) }, supabaseConfigured: true }));

import { CrmError, errorText, rpc, toCrmError } from './api';

describe('toCrmError', () => {
  it('maps contract codes to Polish text', () => {
    const e = toCrmError({ code: 'CR409', message: 'version_conflict', details: 'x' });
    expect(e).toBeInstanceOf(CrmError);
    expect(e.code).toBe('CR409');
    expect(e.messagePl).toMatch(/Ktoś właśnie zmienił/);
  });
  it('looks up key texts by own keys only (SEC-R3-N1)', () => {
    expect(toCrmError({ code: 'CR413', message: 'dictionary_full' }).messagePl).toMatch(/Słownik wartości/);
    const e = toCrmError({ code: 'CR422', message: 'constructor' });
    expect(typeof e.messagePl).toBe('string');
    expect(e.messagePl).toMatch(/Nieprawidłowe dane/);
  });
  it('treats an expired JWT as not signed in', () => {
    expect(toCrmError({ code: 'PGRST301', message: 'JWT expired' }).code).toBe('CR401');
  });
  it('recognises network failures', () => {
    expect(toCrmError({ message: 'TypeError: Failed to fetch' }).code).toBe('NETWORK');
  });
  it('hides technical detail of unknown errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = toCrmError({ code: '23505', message: 'duplicate key value violates unique constraint "secret_name"' });
    expect(e.code).toBe('UNKNOWN');
    expect(e.messagePl).not.toMatch(/secret_name/);
    expect(spy).toHaveBeenCalled();
  });
});

describe('rpc', () => {
  beforeEach(() => { rpcMock.mockReset(); });
  it('returns data', async () => {
    rpcMock.mockResolvedValue({ data: { total: 3 }, error: null });
    await expect(rpc('leads_count', { p_filter: {} })).resolves.toEqual({ total: 3 });
    expect(rpcMock).toHaveBeenCalledWith('leads_count', { p_filter: {} });
  });
  it('throws CrmError with the Polish message', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: 'CR403', message: 'forbidden' } });
    await expect(rpc('db_usage', {})).rejects.toMatchObject({ code: 'CR403' });
    expect(errorText(new CrmError('CR403', 'Nie masz uprawnień do tej operacji.'))).toMatch(/uprawnień/);
  });
  it('wraps thrown network errors', async () => {
    rpcMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(rpc('me', {})).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
