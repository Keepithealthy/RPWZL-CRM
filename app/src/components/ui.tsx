import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal } from './Modal';

type ToastKind = 'ok' | 'error' | 'info';
interface ToastItem { id: number; text: string; kind: ToastKind }
interface ConfirmOpts { title?: string; confirmLabel?: string; danger?: boolean }
interface UiApi {
  toast: (text: string, kind?: ToastKind) => void;
  confirm: (message: string, opts?: ConfirmOpts) => Promise<boolean>;
}

const UiContext = createContext<UiApi | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [ask, setAsk] = useState<{ message: string; opts: ConfirmOpts; resolve: (v: boolean) => void } | null>(null);
  const idRef = useRef(1);

  const toast = useCallback((text: string, kind: ToastKind = 'ok') => {
    const id = idRef.current++;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);

  const confirm = useCallback(
    (message: string, opts: ConfirmOpts = {}) => new Promise<boolean>((resolve) => setAsk({ message, opts, resolve })),
    [],
  );

  const api = useMemo(() => ({ toast, confirm }), [toast, confirm]);
  const answer = (v: boolean) => {
    ask?.resolve(v);
    setAsk(null);
  };

  return (
    <UiContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>
        ))}
      </div>
      {ask ? (
        <Modal
          title={ask.opts.title ?? 'Potwierdź'}
          onClose={() => answer(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => answer(false)}>Anuluj</button>
              <button type="button" className={ask.opts.danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => answer(true)} autoFocus>
                {ask.opts.confirmLabel ?? 'Potwierdzam'}
              </button>
            </>
          }
        >
          <p>{ask.message}</p>
        </Modal>
      ) : null}
    </UiContext.Provider>
  );
}

export function useUi(): UiApi {
  const c = useContext(UiContext);
  if (!c) throw new Error('UiProvider missing');
  return c;
}
