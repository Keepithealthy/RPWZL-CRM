import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ERR, ERROR_TEXT_PL, type Me } from '../../lib/contract';
import { CrmError, rpc, toCrmError } from '../../lib/api';
import { supabase, supabaseConfigured } from '../../lib/supabase';

export type AuthStatus = 'loading' | 'out' | 'in';

interface AuthApi {
  status: AuthStatus;
  me: Me | null;
  /** message shown on the login screen (e.g. account not on the allowlist) */
  notice: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<Session | null | undefined>(supabaseConfigured ? undefined : null);
  const [notice, setNotice] = useState<string | null>(null);
  // a sign-out the user asked for ("Wyloguj") is not an expired session
  const manualSignOut = useRef(false);
  const hadSession = useRef(false);

  useEffect(() => {
    if (!supabaseConfigured) return;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setSession(data.session);
    }).catch(() => {
      if (alive) setSession(null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // forced sign-out (CR401 from an RPC, a refresh token that no longer works): tell the user why (E7)
      if (event === 'SIGNED_OUT' && hadSession.current && !manualSignOut.current) setNotice((n) => n ?? ERROR_TEXT_PL.CR401);
      if (event === 'SIGNED_OUT') manualSignOut.current = false;
      hadSession.current = Boolean(s);
      setSession(s);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const userId = session?.user.id ?? null;
  const meQuery = useQuery({
    queryKey: ['me', userId],
    enabled: Boolean(userId),
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      try {
        return await rpc('me', {});
      } catch (e) {
        const err = toCrmError(e);
        if (err.code === ERR.NOT_MEMBER || err.code === ERR.NOT_SIGNED_IN) {
          setNotice(err.messagePl);
          await supabase.auth.signOut();
        }
        throw err;
      }
    },
  });

  const signIn = useCallback(async (email: string, password: string) => {
    setNotice(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      const network = !error.status || error.status >= 500;
      throw new CrmError(network ? 'NETWORK' : 'UNKNOWN', network ? 'Brak połączenia z serwerem. Spróbuj ponownie.' : 'Nieprawidłowy e-mail lub hasło.', error.message);
    }
  }, []);

  const signOut = useCallback(async () => {
    manualSignOut.current = true;
    setNotice(null);
    await supabase.auth.signOut();
    qc.clear();
  }, [qc]);

  const value = useMemo<AuthApi>(() => {
    const status: AuthStatus = session === undefined ? 'loading' : !session ? 'out' : meQuery.data ? 'in' : meQuery.isError ? 'out' : 'loading';
    return { status, me: meQuery.data ?? null, notice, signIn, signOut };
  }, [session, meQuery.data, meQuery.isError, notice, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const c = useContext(AuthContext);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}

/** The signed-in team member. Only call below the sign-in guard. */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('useMe outside a signed-in session');
  return me;
}

export const useIsOwner = (): boolean => useMe().role === 'owner';
