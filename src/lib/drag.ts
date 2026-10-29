/** Pixels a press may wander before it counts as a drag. */
export const DRAG_SLOP = 3;

export interface DragHandlers {
  /** `dx`, `dy` from the press point. Called only once past the slop. */
  move: (dx: number, dy: number, e: PointerEvent) => void;
  /** `moved` is false for a plain click. */
  end: (moved: boolean, e: PointerEvent) => void;
  /** Pixels before it counts as a drag; `DRAG_SLOP` by default. */
  slop?: number;
}

/** Follows the pointer from a press until release, anywhere in the window. */
export function startDrag(e: React.PointerEvent | PointerEvent, h: DragHandlers): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  const y0 = e.clientY;
  let moved = false;
  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    const slop = h.slop ?? DRAG_SLOP;
    if (!moved && Math.abs(dx) < slop && Math.abs(dy) < slop) return;
    moved = true;
    h.move(dx, dy, ev);
  };
  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("dragging");
    h.end(moved, ev);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  document.body.classList.add("dragging");
}
