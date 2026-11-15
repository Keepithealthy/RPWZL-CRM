import { describe, expect, it } from 'vitest';
import { CrmError } from '../../lib/api';
import { ERROR_KEY_TEXT_PL, ERROR_TEXT_PL } from '../../lib/contract';
import { importFailure } from './failure';

describe('importFailure (UX-R3-2)', () => {
  it('a refused file: import-specific opening, no form advice, detail on its own, no retry', () => {
    const f = importFailure(new CrmError('CR422', ERROR_TEXT_PL.CR422, 'keyHash=00000000000000a1: more than 2000 facet values in one row'), 'x');
    expect(f.message).toMatch(/^Baza danych odrzuciła dane z tego pliku/);
    expect(f.message).not.toMatch(/formularz|Zawęź/);
    expect(f.message).not.toMatch(/facet/);
    expect(f.detail).toBe('CR422: keyHash=00000000000000a1: more than 2000 facet values in one row');
    expect(f.retry).toBe(false);
    const t = importFailure(new CrmError('CR413', ERROR_TEXT_PL.CR413, 'more than 1000 rows'), 'x');
    expect(t.message).not.toMatch(/Zawęź wybór/);
    expect(t.retry).toBe(false);
  });
  it('a key text that already says what to do is not repeated', () => {
    const f = importFailure(new CrmError('CR413', ERROR_KEY_TEXT_PL.dictionary_full!, 'dictionary full'), 'x');
    expect(f.message.startsWith(ERROR_KEY_TEXT_PL.dictionary_full!)).toBe(true);
    expect(f.message.match(/nie pomoże/g)).toHaveLength(1);
    expect(f.retry).toBe(false);
  });
  it('another import running: nothing was written, try again later', () => {
    const f = importFailure(new CrmError('CR423', ERROR_TEXT_PL.CR423, 'run 3'), 'x');
    expect(f.message).toMatch(/Nic nie zostało zapisane\. Spróbuj ponownie za kilka minut\./);
    expect(f.message).not.toMatch(/wycofany/);
    expect(f.retry).toBe(true);
  });
  it('other failures can be resumed with the same file', () => {
    const f = importFailure(new Error('boom'), 'Brak połączenia.');
    expect(f.message).toMatch(/^Brak połączenia\. .*Wybierz ten sam plik jeszcze raz/);
    expect(f.detail).toBeNull();
    expect(f.retry).toBe(true);
  });
});
