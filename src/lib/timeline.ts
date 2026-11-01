import { useEffect, useRef } from "react";
import { useSession, gridOf } from "@/stores/session-store";
import { labelFrames } from "@/lib/grid";
import { clamp } from "@/lib/format";
import { SmoothScrollTop, smoothScroll, smoothZoom } from "@/lib/smooth-view";
import { categoryById } from "@/lib/categories";

/** Top of the envelope range, as in `dawg_core::ENV_MAX`: 0 dB sits at 80%. */
export const ENV_MAX = 1.25;

/** Clip colours from the mockup, one per track in turn. */
export const COLORS = ["#ee9f98", "#f5c55c", "#c3dd76", "#7dd6c4", "#9ec8ea", "#f0a8cf", "#b9c2cf", "#dcc89f"];

/** A track's clip colour: the one picked for it, else its category's, else
 * by position. */
export function trackColor(index: number, color: number | null = null, category: string | null = null): string {
  return COLORS[(color ?? categoryById(category)?.color ?? index) % COLORS.length];
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

/** Where Ctrl+wheel zooms around for the mouse at `x` px: the ruler's
 * labelled step nearest it, so zooming lands on round times or bars. */
function zoomPivot(x: number): number {
  const s = useSession.getState();
  if (!s.session) return x;
  const { units } = gridOf(s);
  const { start, fpp } = s.view;
  const step = labelFrames(units, s.session.rate, s.session.bpm, fpp);
  const f = Math.round((start + x * fpp) / step) * step;
  return clamp((f - start) / fpp, 0, s.width);
}

/** The playlist's wheel: plain scrolls the tracks, Shift (or a sideways
 * wheel) scrolls through time, Ctrl zooms time around the mouse and Alt
 * zooms the track height around the mouse (`onVZoom`). */
export function useWheel(
  ref: React.RefObject<HTMLDivElement | null>,
  onVZoom?: (factor: number, clientY: number) => void,
) {
  const vzoom = useRef(onVZoom);
  useEffect(() => {
    vzoom.current = onVZoom;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const smooth = new SmoothScrollTop(el);
    const onWheel = (e: WheelEvent) => {
      // Some systems turn Shift or Alt+wheel into a sideways wheel.
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (e.ctrlKey) {
        e.preventDefault();
        const lane = (e.target as HTMLElement).closest(".lane, .ruler");
        const r = (lane ?? el).getBoundingClientRect();
        smoothZoom(zoomPivot(e.clientX - r.left), Math.exp(d * 0.0025));
        return;
      }
      if (e.altKey) {
        e.preventDefault();
        vzoom.current?.(Math.exp(-d * 0.0025), e.clientY);
        return;
      }
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        smoothScroll(d);
        return;
      }
      // The plain wheel scrolls the tracks, when they overflow.
      e.preventDefault();
      smooth.by(e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      smooth.cancel();
    };
  }, [ref]);
}
