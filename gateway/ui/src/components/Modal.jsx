// Dialog box shown over the page. Closes with Escape or the close button, and keeps
// keyboard focus inside while open.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export default function Modal({ title, onClose, children, footer, wide = false }) {
  const boxRef = useRef(null);

  useEffect(() => {
    const previous = document.activeElement;
    const box = boxRef.current;
    box?.querySelector("input, button, [href], select, textarea")?.focus();
    document.body.style.overflow = "hidden";

    function onKey(e) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && box) {
        const items = box.querySelectorAll("input, button, [href], select, textarea");
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      previous?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/80 p-4" onMouseDown={onClose}>
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex max-h-[calc(100dvh-2rem)] w-full ${wide ? "max-w-2xl" : "max-w-md"} flex-col rounded-lg border border-edge bg-solid shadow-2xl`}
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-4">
          <h2 id="modal-title" className="font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-fg"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-edge px-5 py-4">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}