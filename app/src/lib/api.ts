import { ERROR_KEY_TEXT_PL, ERROR_TEXT_PL, ERR, type ErrorCode, type RpcArgs, type RpcName, type RpcResult } from './contract';
import { supabase } from './supabase';

export type CrmErrorCode = ErrorCode | 'NETWORK' | 'UNKNOWN';

/** Error thrown by every `rpc()` call; `messagePl` is safe to show to the user. */
export class CrmError extends Error {
  code: CrmErrorCode;
  messagePl: string;
  detail?: string;
  constructor(code: CrmErrorCode, messagePl: string, detail?: string) {
    super(messagePl);
    this.name = 'CrmError';
    this.code = code;
    this.messagePl = messagePl;
    this.detail = detail;
  }
}

interface PostgrestLike { code?: string; message?: string; details?: string; hint?: string }

const KNOWN = new Set<string>(Object.values(ERR));

/** Maps a PostgREST / supabase-js error to a CrmError (contract section 2). */
export function toCrmError(err: unknown): CrmError {
  if (err instanceof CrmError) return err;
  const e = (err ?? {}) as PostgrestLike;
  const code = String(e.code ?? '');
  if (KNOWN.has(code)) {
    const byKey = e.message && Object.hasOwn(ERROR_KEY_TEXT_PL, e.message) ? ERROR_KEY_TEXT_PL[e.message] : undefined;
    return new CrmError(code as ErrorCode, byKey ?? ERROR_TEXT_PL[code as ErrorCode], e.details || e.message);
  }
  // Expired / invalid JWT is reported by PostgREST itself, before our function runs.
  if (code === 'PGRST301' || code === 'PGRST303' || /jwt/i.test(e.message ?? '')) {
    return new CrmError(ERR.NOT_SIGNED_IN, ERROR_TEXT_PL.CR401, e.message);
  }
  if (!code && /failed to fetch|network|load failed|fetch/i.test(e.message ?? '')) {
    return new CrmError('NETWORK', 'Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.', e.message);
  }
  // Unknown: keep the technical detail on the console only (never sent anywhere).
  console.error('[crm] nieobsłużony błąd', code, e.message, e.details);
  return new CrmError('UNKNOWN', 'Coś poszło nie tak. Spróbuj ponownie; jeśli się powtarza, daj znać właścicielowi.', e.message);
}

/** Typed RPC call. Throws CrmError. */
export async function rpc<N extends RpcName>(name: N, args: RpcArgs<N>): Promise<RpcResult<N>> {
  let res;
  try {
    res = await supabase.rpc(name, args as never);
  } catch (e) {
    throw toCrmError(e);
  }
  if (res.error) throw toCrmError(res.error);
  return res.data as RpcResult<N>;
}

/** Text for any thrown value, for toasts and inline errors. */
export function errorText(e: unknown): string {
  return e instanceof CrmError ? e.messagePl : toCrmError(e).messagePl;
}
