import type { ReactNode } from 'react';
import { errorText } from '../lib/api';

export function Spinner({ label = 'Wczytywanie…' }: { label?: string }) {
  return <p className="muted" role="status">{label}</p>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="alert alert-error" role="alert">
      <span>{errorText(error)}</span>
      {onRetry ? <button type="button" className="btn btn-sm" onClick={onRetry}>Spróbuj ponownie</button> : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function Badge({ children, tone = 'gray', title }: { children: ReactNode; tone?: 'gray' | 'red' | 'green' | 'yellow' | 'blue'; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

export function PageHeader({ title, children, help }: { title: string; children?: ReactNode; help?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {help ? <p className="muted">{help}</p> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </header>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <nav className="pager" aria-label="Strony wyników">
      <button type="button" className="btn btn-sm" disabled={page <= 0} onClick={() => onPage(page - 1)}>‹ Poprzednia</button>
      <span>{from}–{to} z {total} · strona {page + 1} z {pages}</span>
      <button type="button" className="btn btn-sm" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Następna ›</button>
    </nav>
  );
}
