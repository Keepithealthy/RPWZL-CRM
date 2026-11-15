import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { OwnerOnly, RequireAuth, lazyOptionalScreen } from './components/Guards';
import { Spinner } from './components/common';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthProvider } from './features/auth/AuthProvider';
import { UiProvider } from './components/ui';
import LeadsScreen from './features/leads/LeadsScreen';

const CardScreen = lazy(() => import('./features/card/CardScreen'));
const TodayScreen = lazy(() => import('./features/today/TodayScreen'));
const TasksScreen = lazy(() => import('./features/tasks/TasksScreen'));
const TemplatesScreen = lazy(() => import('./features/templates/TemplatesScreen'));
const ListsScreen = lazy(() => import('./features/lists/ListsScreen'));
const SettingsScreen = lazy(() => import('./features/settings/SettingsScreen'));
const UsersScreen = lazy(() => import('./features/users/UsersScreen'));
const ExportScreen = lazy(() => import('./features/export/ExportScreen'));

// Owned by the IMPORT + VALIDATION builder (CONTRACT 1); resolved by path, placeholder until the file exists.
const ImportScreen = lazyOptionalScreen(import.meta.glob('./features/import/ImportScreen.tsx'), 'Import');
const ValidationScreen = lazyOptionalScreen(import.meta.glob('./features/validation/ValidationScreen.tsx'), 'Walidacja');

export function App() {
  return (
    <UiProvider>
      <AuthProvider>
        <BrowserRouter>
          <RequireAuth>
            <ErrorBoundary>
            <Suspense fallback={<div className="center-pad"><Spinner /></div>}>
              <Routes>
                <Route element={<Layout />}>
                  <Route index element={<Navigate to="/dzis" replace />} />
                  <Route path="/dzis" element={<TodayScreen />} />
                  <Route path="/leady" element={<LeadsScreen />} />
                  <Route path="/lead/:id" element={<CardScreen />} />
                  <Route path="/zadania" element={<TasksScreen />} />
                  <Route path="/walidacja" element={<ValidationScreen />} />
                  <Route path="/listy" element={<ListsScreen />} />
                  <Route path="/szablony" element={<TemplatesScreen />} />
                  <Route path="/import" element={<OwnerOnly><ImportScreen /></OwnerOnly>} />
                  <Route path="/eksport" element={<OwnerOnly><ExportScreen /></OwnerOnly>} />
                  <Route path="/uzytkownicy" element={<OwnerOnly><UsersScreen /></OwnerOnly>} />
                  <Route path="/ustawienia" element={<OwnerOnly><SettingsScreen /></OwnerOnly>} />
                  <Route path="*" element={<Navigate to="/dzis" replace />} />
                </Route>
              </Routes>
            </Suspense>
            </ErrorBoundary>
          </RequireAuth>
        </BrowserRouter>
      </AuthProvider>
    </UiProvider>
  );
}
