import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256, hash64Hex, hash64Signed, hexToSignedDecimal, sha256Hex, toHex } from './sha256';

const ref = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

describe('sha256', () => {
  it('matches node:crypto for every length around the block boundaries', () => {
    for (let n = 0; n <= 200; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
      expect(sha256Hex(bytes)).toBe(ref(bytes));
    }
  });

  it('hashes UTF-8 strings (Polish characters)', () => {
    const s = 'Żółć gęślą jaźń, Ł-ó-d-ź 😀';
    expect(sha256Hex(s)).toBe(ref(Buffer.from(s, 'utf8')));
  });

  it('is incremental: any chunking gives the same digest', () => {
    const bytes = new Uint8Array(100_003).map((_, i) => (i * 7 + 3) & 255);
    const h = new Sha256();
    let off = 0;
    for (const step of [1, 63, 64, 65, 1000, 4096, 90_000]) {
      h.update(bytes.subarray(off, off + step));
      off += step;
    }
    h.update(bytes.subarray(off));
    expect(toHex(h.digest())).toBe(ref(bytes));
  });

  it('known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('64-bit forms: 16 hex digits and signed decimal', () => {
    expect(hash64Hex('abc')).toBe('ba7816bf8f01cfea');
    expect(hash64Signed('abc')).toBe(BigInt.asIntN(64, 0xba7816bf8f01cfean).toString());
    expect(hexToSignedDecimal('ffffffffffffffff')).toBe('-1');
    expect(hexToSignedDecimal('7fffffffffffffff')).toBe('9223372036854775807');
  });
});
