import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useMe } from '../features/auth/AuthProvider';
import { rpc } from '../lib/api';
import { useRefData } from '../lib/queries';
import { daysSince, fmtDate, fmtNum } from '../lib/format';
import { ErrorBoundary } from './ErrorBoundary';
import { Spinner } from './common';

const NAV: Array<{ to: string; label: string; owner?: boolean; badge?: 'today' }> = [
  { to: '/dzis', label: 'Dziś', badge: 'today' },
  { to: '/leady', label: 'Leady' },
  { to: '/zadania', label: 'Zadania' },
  { to: '/walidacja', label: 'Walidacja' },
  { to: '/listy', label: 'Listy' },
  { to: '/szablony', label: 'Szablony' },
  { to: '/import', label: 'Import', owner: true },
  { to: '/eksport', label: 'Eksport i kopia', owner: true },
  { to: '/uzytkownicy', label: 'Użytkownicy', owner: true },
  { to: '/ustawienia', label: 'Ustawienia', owner: true },
];

export function Layout() {
  const me = useMe();
  const { signOut } = useAuth();
  const ref = useRefData().data;
  const isOwner = me.role === 'owner';
  const today = useQuery({ queryKey: ['today'], queryFn: () => rpc('today', {}), staleTime: 60_000 });
  const usage = useQuery({ queryKey: ['db_usage'], queryFn: () => rpc('db_usage', {}), enabled: isOwner, staleTime: 10 * 60_000 });

  const last = ref?.lastImport ?? null;
  const staleDays = ref?.settings.staleDays ?? 35;
  const age = daysSince(last?.reportDate);
  const stale = last !== null && age !== null && age > staleDays;
  const c = today.data?.counts;
  const badge = c ? c.tasksOverdue + c.tasksToday + c.nextSteps : 0;
  const usageMb = usage.data ? usage.data.bytes / 1_048_576 : 0;

  return (
    <div className="shell">
      <a className="skip" href="#main">Przejdź do treści</a>
      <header className="topbar">
        <strong className="brand">RPWZL CRM</strong>
        <span className="data-age" id="data-date">
          {last ? `Dane z rejestru: stan na ${fmtDate(last.reportDate)}` : 'Brak danych z rejestru'}
        </span>
        <span className="spacer" />
        <span className="who">{me.displayName}{isOwner ? ' (właściciel)' : ''}</span>
        <button type="button" className="btn btn-sm" onClick={() => void signOut()}>Wyloguj</button>
      </header>
      <nav className="sidebar" aria-label="Menu główne">
        <ul>
          {NAV.filter((n) => !n.owner || isOwner).map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} className={({ isActive }) => (isActive ? 'active' : undefined)}>
                {n.label}
                {n.badge === 'today' && badge > 0 ? <span className="badge badge-red" aria-label={`${badge} do zrobienia`}>{fmtNum(badge)}</span> : null}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="content" tabIndex={-1}>
        {stale ? <div className="alert alert-warn" role="status">Dane z rejestru są starsze niż {staleDays} dni — {isOwner ? 'zaimportuj świeży indeks (menu Import).' : 'poproś właściciela o import świeżego indeksu.'}</div> : null}
        {isOwner && usageMb > 400 ? <div className="alert alert-warn" role="status">Baza zbliża się do limitu 500 MB (zajęte {fmtNum(Math.round(usageMb))} MB). Zajrzyj do Ustawień.</div> : null}
        {/* inside the shell, so a screen that fails to load (offline) keeps the menu visible (E2b) */}
        <ErrorBoundary>
          <Suspense fallback={<div className="center-pad"><Spinner /></div>}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}

