import { clamp } from "./format";
import { startDrag } from "./drag";

/** Where `db` sits on the track volume knob: 0 dB at 75% of the travel,
 * +6 dB at the end, -48 dB near the start (as in the mockup). */
export function volKnobFrac(db: number): number {
  return db >= 0 ? 0.75 + (0.25 * db) / 6 : 0.75 * Math.pow(10, db / 40);
}

export interface KnobDrag {
  /** Units per pixel of vertical travel. */
  rate: number;
  min: number;
  max: number;
  /** Ctrl rounds to this. */
  step: number;
  /** Plain drags round to this. */
  res: number;
  /** Values within this of 0 snap to 0, unless Alt or Shift is held. */
  detent: number;
}

/** The mockup's knob drag: up raises, Shift is fine (x0.1), Ctrl steps, and
 * a detent holds 0. `onValue` gets each value and `done` once on release. */
export function dragKnob(e: React.PointerEvent, v0: number, k: KnobDrag, onValue: (v: number, done: boolean) => void) {
  let raw = v0;
  let lastY = e.clientY;
  let v = v0;
  startDrag(e, {
    slop: 1,
    move: (_dx, _dy, ev) => {
      raw = clamp(raw + (lastY - ev.clientY) * k.rate * (ev.shiftKey ? 0.1 : 1), k.min, k.max);
      lastY = ev.clientY;
      v = ev.ctrlKey ? Math.round(raw / k.step) * k.step : Math.round(raw / k.res) * k.res;
      if (k.detent && !ev.altKey && !ev.shiftKey && Math.abs(v) < k.detent) v = 0;
      v = clamp(v, k.min, k.max);
      onValue(v, false);
    },
    end: (moved) => {
      if (moved) onValue(v, true);
    },
  });
}

/** "-3.5", "+2 dB", "−∞" → dB; NaN when it doesn't parse. */
export function parseDb(s: string): number {
  const t = s.replace(/−/g, "-").replace(/db/i, "").trim();
  if (/^-?(inf|∞)/i.test(t)) return -Infinity;
  return t === "" ? NaN : parseFloat(t);
}
