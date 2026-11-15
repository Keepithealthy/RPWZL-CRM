import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, isChunkLoadError } from './ErrorBoundary';

function Boom({ msg }: { msg: string }): never { throw new Error(msg); }

describe('ErrorBoundary', () => {
  it('recognises failed lazy imports', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/TasksScreen-1.js'))).toBe(true);
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
  });
  it('shows a Polish message with a refresh button instead of a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<MemoryRouter><ErrorBoundary><Boom msg="boom" /></ErrorBoundary></MemoryRouter>);
    expect(screen.getByRole('alert').textContent).toContain('Coś poszło nie tak');
    expect(screen.getByRole('button', { name: 'Odśwież stronę' })).toBeTruthy();
  });
  it('does not auto-reload while offline and shows the message instead', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanup();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    sessionStorage.removeItem('rpwzl.chunkReload');
    render(<MemoryRouter><ErrorBoundary><Boom msg="Failed to fetch dynamically imported module: /assets/x.js" /></ErrorBoundary></MemoryRouter>);
    expect(screen.getByRole('alert').textContent).toContain('Nie udało się wczytać ekranu');
    expect(sessionStorage.getItem('rpwzl.chunkReload')).toBeNull();
    vi.restoreAllMocks();
  });
});
