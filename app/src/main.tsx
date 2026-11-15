import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { CrmError } from './lib/api';
import { ERR } from './lib/contract';
import { supabase } from './lib/supabase';
import './styles.css';

// An expired session (CR401) sends the user back to the login screen from anywhere.
const onAuthError = (e: unknown) => {
  if (e instanceof CrmError && e.code === ERR.NOT_SIGNED_IN) void supabase.auth.signOut();
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onAuthError }),
  mutationCache: new MutationCache({ onError: onAuthError }),
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
