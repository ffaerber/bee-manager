/**
 * A modal built on the native <dialog> element.
 *
 * `showModal()` is used rather than a hand-rolled overlay because it brings the
 * accessibility behaviour with it: focus moves into the dialog and is trapped
 * there, the rest of the page becomes inert to assistive tech, Escape closes,
 * and focus returns to whatever opened it. Reimplementing that on a <div> means
 * reimplementing all of it, usually badly.
 *
 * The two things <dialog> does not do are handled here: locking body scroll
 * while open, and closing on a backdrop click.
 */

import { useEffect, useRef } from 'react';

export function Modal({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  /**
   * The close handler is held in a ref so the effect below can run exactly
   * once, on mount.
   *
   * Depending on `onClose` directly closed the dialog on its own. Parents pass
   * an inline arrow, so every parent re-render — the dashboard re-polls every
   * 30s — produced a new function identity, re-running the effect. Its cleanup
   * called close(), and `close()` *queues* the close event rather than firing
   * it synchronously, so that event arrived after the re-run had already
   * attached a fresh listener. The listener could not tell the stale close
   * from a real one and reported it as a user dismissal.
   *
   * Keeping the callback in a ref means the effect never has a reason to
   * re-run, so there is no teardown to be misread.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();

    // Escape fires the dialog's own close event; React state has to follow it,
    // or the component stays mounted with a closed dialog and cannot reopen.
    const onDialogClose = () => onCloseRef.current();
    el.addEventListener('close', onDialogClose);

    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      el.removeEventListener('close', onDialogClose);
      document.body.style.overflow = prev;
      if (el.open) el.close();
    };
  }, []);

  /**
   * A click on the backdrop targets the dialog element itself, since the
   * backdrop is its pseudo-element rather than a child. Anything inside the
   * content wrapper targets that wrapper instead, so this closes only on a
   * genuine outside click.
   */
  function onClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === ref.current) onClose();
  }

  return (
    <dialog ref={ref} className="modal" onClick={onClick} aria-label={title}>
      <div className="modal-body">
        <div className="spread modal-head">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="modal-content">{children}</div>
      </div>
    </dialog>
  );
}
