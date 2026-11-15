import { Component, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/** True for the errors a failed lazy `import()` raises (network down, or old hashed chunks gone after a redeploy). */
export function isChunkLoadError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /dynamically imported module|importing a module script failed|loading chunk|loading css chunk/i.test(m);
}

const RELOAD_KEY = 'rpwzl.chunkReload';

function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? '0');
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch { /* storage blocked: reload once anyway is not possible to remember, so do not loop */ return false; }
  window.location.reload();
  return true;
}

interface State { error: unknown }

/** Catches render and lazy-load errors so the screen never goes blank without a message or a way out. */
class Boundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: unknown): State { return { error: error ?? new Error('unknown') }; }
  componentDidCatch(error: unknown): void {
    // Offline a reload would only land on the browser's own error page: show the Polish message instead.
    if (isChunkLoadError(error) && navigator.onLine !== false) reloadOnce();
  }
  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const chunk = isChunkLoadError(this.state.error);
    return (
      <div className="center-pad" role="alert">
        <h2>{chunk ? 'Nie udało się wczytać ekranu' : 'Coś poszło nie tak'}</h2>
        <p>
          {chunk
            ? 'Brak połączenia z internetem albo aplikacja została właśnie zaktualizowana. Sprawdź połączenie i odśwież stronę.'
            : 'Ten ekran przestał działać. Odśwież stronę. Jeśli problem wraca, zgłoś go właścicielowi.'}
        </p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Odśwież stronę</button>
      </div>
    );
  }
}

/** Resets itself when the route changes, so leaving a broken screen works without a reload. */
export function ErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Boundary key={pathname}>{children}</Boundary>;
}
