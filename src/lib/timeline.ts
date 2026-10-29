import { useEffect } from "react";
import { useSession } from "@/stores/session-store";

/** Top of the envelope range, as in `dawg_core::ENV_MAX`: 0 dB sits at 80%. */
export const ENV_MAX = 1.25;

/** Clip colours from the mockup, one per track in turn. */
const COLORS = ["#ee9f98", "#f5c55c", "#c3dd76", "#7dd6c4", "#9ec8ea", "#f0a8cf", "#b9c2cf", "#dcc89f"];

export function trackColor(index: number): string {
  return COLORS[index % COLORS.length];
}

/** y of envelope gain `g` in a wave area `h` px tall. */
export function envY(g: number, h: number): number {
  return (1 - g / ENV_MAX) * (h - 2) + 1;
}

/** Ctrl+wheel zooms around the mouse; Shift+wheel (or a sideways wheel)
 * scrolls through time; the plain wheel scrolls the tracks. */
export function useWheel(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const s = useSession.getState();
      const lane = (e.target as HTMLElement).closest(".lane, .ruler");
      const r = (lane ?? el).getBoundingClientRect();
      if (e.ctrlKey) {
        e.preventDefault();
        s.zoomAt(e.clientX - r.left, Math.exp(e.deltaY * 0.0025));
        return;
      }
      const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      // With nothing to scroll vertically, the wheel scrolls time.
      const tall = el.scrollHeight > el.clientHeight;
      if (sideways || !tall) {
        e.preventDefault();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        s.scrollTo(s.view.start + d * s.view.fpp);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}
