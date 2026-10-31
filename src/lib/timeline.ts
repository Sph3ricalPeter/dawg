import { useEffect } from "react";
import { useSession } from "@/stores/session-store";

/** Top of the envelope range, as in `dawg_core::ENV_MAX`: 0 dB sits at 80%. */
export const ENV_MAX = 1.25;

/** Clip colours from the mockup, one per track in turn. */
export const COLORS = ["#ee9f98", "#f5c55c", "#c3dd76", "#7dd6c4", "#9ec8ea", "#f0a8cf", "#b9c2cf", "#dcc89f"];

/** A track's clip colour: the one picked for it, else by position. */
export function trackColor(index: number, color: number | null = null): string {
  return COLORS[(color ?? index) % COLORS.length];
}

/** Seconds between ruler labels, picked so labels sit at least ~70 px apart. */
const STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function rulerStep(pxPerSec: number): number {
  return STEPS.find((s) => s * pxPerSec >= 70) ?? 600;
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
