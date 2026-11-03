import { type RefObject, useEffect, useRef } from "react";

/** While `open`, a mouse-down outside `ref` or Escape calls `close`: every
 * menu and popover closes the same way. `capture` takes Escape before
 * anything else on the page sees it (and stops it there). */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void, capture = false) {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) latest.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (capture) {
        e.stopPropagation();
        e.preventDefault();
      }
      latest.current();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, capture);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, capture);
    };
  }, [open, ref, capture]);
}
