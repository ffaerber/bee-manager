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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();

    // Escape fires the dialog's own close event; React state has to follow it,
    // or the component stays mounted with a closed dialog and cannot reopen.
    const onCancel = () => onClose();
    el.addEventListener('close', onCancel);

    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      el.removeEventListener('close', onCancel);
      document.body.style.overflow = prev;
      if (el.open) el.close();
    };
  }, [onClose]);

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
