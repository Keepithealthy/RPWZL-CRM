import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { UiProvider } from '../components/ui';

export function renderApp(ui: ReactElement, route = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <UiProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </UiProvider>
    </QueryClientProvider>,
  );
}

/** Dispatch table for a mocked rpc(): name -> handler(args) | value. Unknown names fail loudly. */
export function makeRpc(table: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fn = (...call: unknown[]) => {
    const name = String(call[0]);
    const args = (call[1] ?? {}) as Record<string, unknown>;
    calls.push({ name, args });
    if (!(name in table)) return Promise.reject(new Error(`unmocked rpc ${name}`));
    const h = table[name];
    return Promise.resolve(typeof h === 'function' ? (h as (a: Record<string, unknown>) => unknown)(args) : h);
  };
  return { fn, calls };
}
