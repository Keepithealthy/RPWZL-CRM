import { useEffect, useRef, type ReactNode } from 'react';

interface Props { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode; label?: string }

/** Accessible modal on the native <dialog>: Esc closes, focus is trapped by the browser, focus returns to the opener. */
export function Modal({ title, onClose, children, wide, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opener = document.activeElement as HTMLElement | null;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
    const onCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    d.addEventListener('cancel', onCancel);
    return () => {
      d.removeEventListener('cancel', onCancel);
      if (typeof d.close === 'function' && d.open) d.close();
      opener?.focus?.();
    };
  }, []);
  return (
    <dialog ref={ref} className={`modal${wide ? ' modal-wide' : ''}`} aria-label={title}>
      <div className="modal-head">
        <h2>{title}</h2>
        <button type="button" className="btn-icon" onClick={onClose} aria-label="Zamknij">×</button>
      </div>
      <div className="modal-body">{children}</div>
      {footer ? <div className="modal-foot">{footer}</div> : null}
    </dialog>
  );
}
