import type { LeadFilter } from './contract';

/** A filter in the URL is base64url of the JSON LeadFilter (SPEC 3). */
export function encodeFilter(f: LeadFilter): string {
  const bytes = new TextEncoder().encode(JSON.stringify(f));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeFilter(s: string | null | undefined): LeadFilter | null {
  if (!s) return null;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as LeadFilter) : null;
  } catch {
    return null;
  }
}

/** Drops empty values so that equal filters compare equal and the URL stays short. */
export function cleanFilter(f: LeadFilter): LeadFilter {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === 'kind' && v === 'all') continue;
    if (k === 'inRegister' && v === 'yes') continue;
    if (k === 'tagsMode' && v === 'any') continue;
    if (k === 'dnc' && v === 'all') continue;
    if (k === 'sel') {
      const sel: Record<string, string[]> = {};
      for (const [fk, fv] of Object.entries(v as Record<string, string[]>)) if (fv && fv.length) sel[fk] = fv;
      if (Object.keys(sel).length === 0) continue;
      out[k] = sel;
      continue;
    }
    if (k === 'contact') {
      const c: Record<string, boolean> = {};
      for (const [ck, cv] of Object.entries(v as Record<string, boolean>)) if (cv) c[ck] = true;
      if (Object.keys(c).length === 0) continue;
      out[k] = c;
      continue;
    }
    out[k] = v;
  }
  return out as LeadFilter;
}

export function sameFilter(a: LeadFilter, b: LeadFilter): boolean {
  const norm = (f: LeadFilter) => JSON.stringify(sortKeys(cleanFilter(f)));
  return norm(a) === norm(b);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, sortKeys(x)]));
  }
  return v;
}
