/**
 * Synchronous, incremental SHA-256. The import worker hashes ~800 k small strings and the whole 60 MB file;
 * `crypto.subtle.digest` is async and one-shot, which is too slow and cannot stream. Verified against node:crypto in
 * sha256.test.ts.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const encoder = new TextEncoder();

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private block = new Uint8Array(64);
  private w = new Uint32Array(64);
  private fill = 0;
  private total = 0;

  update(data: Uint8Array | string): this {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    let i = 0;
    const n = bytes.length;
    this.total += n;
    if (this.fill > 0) {
      const take = Math.min(64 - this.fill, n);
      this.block.set(bytes.subarray(0, take), this.fill);
      this.fill += take;
      i = take;
      if (this.fill === 64) {
        this.compress(this.block, 0);
        this.fill = 0;
      }
    }
    for (; i + 64 <= n; i += 64) this.compress(bytes, i);
    if (i < n) {
      this.block.set(bytes.subarray(i), 0);
      this.fill = n - i;
    }
    return this;
  }

  /** Finishes the hash and returns the 32 digest bytes. The instance must not be used afterwards. */
  digest(): Uint8Array {
    const bits = this.total * 8;
    const pad = new Uint8Array(((this.fill < 56 ? 56 : 120) - this.fill) + 8);
    pad[0] = 0x80;
    const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    const L = pad.length;
    pad[L - 8] = (hi >>> 24) & 255; pad[L - 7] = (hi >>> 16) & 255; pad[L - 6] = (hi >>> 8) & 255; pad[L - 5] = hi & 255;
    pad[L - 4] = (lo >>> 24) & 255; pad[L - 3] = (lo >>> 16) & 255; pad[L - 2] = (lo >>> 8) & 255; pad[L - 1] = lo & 255;
    const keepTotal = this.total;
    this.update(pad);
    this.total = keepTotal;
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      const v = this.h[i] as number;
      out[i * 4] = v >>> 24; out[i * 4 + 1] = (v >>> 16) & 255; out[i * 4 + 2] = (v >>> 8) & 255; out[i * 4 + 3] = v & 255;
    }
    return out;
  }

  private compress(b: Uint8Array, off: number): void {
    const w = this.w, h = this.h;
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] = ((b[j] as number) << 24) | ((b[j + 1] as number) << 16) | ((b[j + 2] as number) << 8) | (b[j + 3] as number);
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15] as number, y = w[t - 2] as number;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) | 0;
    }
    let a = h[0] as number, bb = h[1] as number, c = h[2] as number, d = h[3] as number;
    let e = h[4] as number, f = h[5] as number, g = h[6] as number, hh = h[7] as number;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[t] as number) + (w[t] as number)) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + mj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0; h[1] = ((h[1] as number) + bb) | 0; h[2] = ((h[2] as number) + c) | 0; h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0; h[5] = ((h[5] as number) + f) | 0; h[6] = ((h[6] as number) + g) | 0; h[7] = ((h[7] as number) + hh) | 0;
  }
}

export function toHex(bytes: Uint8Array, from = 0, to = bytes.length): string {
  let s = '';
  for (let i = from; i < to; i++) s += HEX[bytes[i] as number];
  return s;
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Sha256().update(data).digest();
}

export function sha256Hex(data: Uint8Array | string): string {
  return toHex(sha256(data));
}

/** First 8 bytes of SHA-256 as 16 lower-case hex digits (the contract's `keyHash` / `groupKey` form). */
export function hash64Hex(data: Uint8Array | string): string {
  return toHex(sha256(data), 0, 8);
}

/** First 8 bytes as a signed big-endian int64 in decimal (the contract's `h(x)` form). */
export function hash64Signed(data: Uint8Array | string): string {
  return hexToSignedDecimal(hash64Hex(data));
}

export function hexToSignedDecimal(hex16: string): string {
  return BigInt.asIntN(64, BigInt('0x' + hex16)).toString();
}
