import { lazy, type ComponentType, type ReactNode } from 'react';
import { useAuth, useMe } from '../features/auth/AuthProvider';
import LoginScreen from '../features/auth/LoginScreen';
import { Empty, Spinner } from './common';

/** Shows the login screen until a team member is signed in. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <div className="center-pad"><Spinner label="Wczytywanie…" /></div>;
  if (status === 'out') return <LoginScreen />;
  return <>{children}</>;
}

export function OwnerOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.role !== 'owner') return <Empty title="Ta strona jest tylko dla właściciela.">Poproś właściciela o wykonanie tej czynności.</Empty>;
  return <>{children}</>;
}

/**
 * Lazy screen owned by another builder (import, validation). The component is resolved by path through
 * `import.meta.glob`, so the app builds and shows a placeholder while the file does not exist yet.
 */
export function lazyOptionalScreen(loaders: Record<string, () => Promise<unknown>>, title: string): React.LazyExoticComponent<ComponentType> {
  const loader = Object.values(loaders)[0];
  return lazy(async () => {
    if (loader) return (await loader()) as { default: ComponentType };
    return { default: () => <Empty title={`${title}: ten ekran nie jest jeszcze dostępny.`}>Ta część aplikacji jest w budowie.</Empty> };
  });
}
