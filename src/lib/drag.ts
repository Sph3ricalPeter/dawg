/** Pixels a press may wander before it counts as a drag. */
export const DRAG_SLOP = 3;

export interface DragHandlers {
  /** `dx`, `dy` from the press point. Called only once past the slop. */
  move: (dx: number, dy: number, e: PointerEvent) => void;
  /** `moved` is false for a plain click. */
  end: (moved: boolean, e: PointerEvent) => void;
  /** Pixels before it counts as a drag; `DRAG_SLOP` by default. */
  slop?: number;
  /** For relative value drags (knobs, BPM): once the drag starts, lock the
   * pointer so it keeps counting past the screen edge, with the cursor
   * hidden. On release it shows again where the drag began. Falls back to
   * plain pointer tracking where pointer lock isn't available. */
  lock?: boolean;
}

/** Chromium sometimes reports one huge jump right after the lock begins. */
const MAX_LOCKED_STEP = 400;

/** Follows the pointer from a press until release, anywhere in the window. */
export function startDrag(e: React.PointerEvent | PointerEvent, h: DragHandlers): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const target = (e.currentTarget ?? e.target) as Element | null;
  let lastX = e.clientX;
  let lastY = e.clientY;
  // Travel since the press. Summed from per-event steps so that it keeps
  // growing while the pointer is locked (clientX/Y freeze then).
  let dx = 0;
  let dy = 0;
  let moved = false;
  let locking = false;
  const locked = () => locking && target !== null && document.pointerLockElement === target;
  const onMove = (ev: PointerEvent) => {
    if (locked()) {
      if (Math.abs(ev.movementX) > MAX_LOCKED_STEP || Math.abs(ev.movementY) > MAX_LOCKED_STEP) return;
      dx += ev.movementX;
      dy += ev.movementY;
    } else {
      dx += ev.clientX - lastX;
      dy += ev.clientY - lastY;
    }
    lastX = ev.clientX;
    lastY = ev.clientY;
    const slop = h.slop ?? DRAG_SLOP;
    if (!moved && Math.abs(dx) < slop && Math.abs(dy) < slop) return;
    if (!moved && h.lock && target && target.requestPointerLock) {
      locking = true;
      try {
        // Newer Chromium returns a promise; a refusal just means no lock.
        const p = target.requestPointerLock() as unknown as Promise<void> | undefined;
        p?.catch?.(() => (locking = false));
      } catch {
        locking = false;
      }
    }
    moved = true;
    h.move(dx, dy, ev);
  };
  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("dragging");
    if (locking && document.pointerLockElement === target) document.exitPointerLock();
    h.end(moved, ev);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  document.body.classList.add("dragging");
}
