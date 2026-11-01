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
 * a detent holds 0. `onValue` gets each value and `done` once on release.
 * The pointer is locked while dragging, so the drag carries on past the
 * screen edge. */
export function dragKnob(e: React.PointerEvent, v0: number, k: KnobDrag, onValue: (v: number, done: boolean) => void) {
  let raw = v0;
  let lastDy = 0;
  let v = v0;
  startDrag(e, {
    slop: 1,
    lock: true,
    move: (_dx, dy, ev) => {
      raw = clamp(raw + (lastDy - dy) * k.rate * (ev.shiftKey ? 0.1 : 1), k.min, k.max);
      lastDy = dy;
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

/** One wheel notch in pixels (Chromium reports 100 for a mouse notch). */
const NOTCH = 100;
/** A wheel gesture ends, and becomes one undo step, after this much quiet. */
const WHEEL_IDLE_MS = 400;

interface WheelKnob {
  v0: number;
  k: KnobDrag;
  onValue: (v: number, done: boolean) => void;
}
interface WheelGesture {
  el: Element;
  v: number;
  acc: number;
  timer: number;
}

const wheelKnobs = new WeakMap<Element, WheelKnob>();
let gesture: WheelGesture | null = null;

function endGesture() {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  window.clearTimeout(g.timer);
  wheelKnobs.get(g.el)?.onValue(g.v, true);
}

function onWheel(e: WheelEvent) {
  let el = e.target instanceof Element ? e.target : null;
  if (el?.closest("input, textarea, select")) return;
  while (el && !wheelKnobs.has(el)) el = el.parentElement;
  if (!el) return;
  const w = wheelKnobs.get(el)!;
  e.preventDefault();
  e.stopPropagation();
  if (gesture && gesture.el !== el) endGesture();
  if (!gesture) gesture = { el, v: w.v0, acc: 0, timer: 0 };
  const g = gesture;
  window.clearTimeout(g.timer);
  g.timer = window.setTimeout(endGesture, WHEEL_IDLE_MS);
  // Shift+wheel arrives as horizontal scroll on Windows.
  const px = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
  g.acc -= px / NOTCH;
  const notches = Math.trunc(g.acc);
  if (!notches) return;
  g.acc -= notches;
  const { k } = w;
  let v: number;
  if (e.shiftKey) {
    // Fine: a tenth of a step per notch, on the drag's resolution.
    v = Math.round((g.v + (notches * k.step) / 10) / k.res) * k.res;
  } else {
    // A notch goes to the next whole step, so values land on 0, -3, +6...
    const s = g.v / k.step;
    const eps = 1e-6;
    v = (notches > 0 ? Math.floor(s + eps) + notches : Math.ceil(s - eps) + notches) * k.step;
  }
  v = clamp(v, k.min, k.max);
  if (v === g.v) return;
  g.v = v;
  w.onValue(v, false);
}

let wheelListening = false;

/** A knob's handlers: drag (see `dragKnob`) and the mouse wheel while the
 * pointer is over it (a notch is one Ctrl step, Shift a tenth of one; one
 * gesture is one undo step). Spread `ref` and `onPointerDown` on the
 * knob's element. */
export function knobControl(v0: number, k: KnobDrag, onValue: (v: number, done: boolean) => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      endGesture();
      dragKnob(e, v0, k, onValue);
    },
    ref: (el: Element | null) => {
      if (!el) return;
      if (!wheelListening) {
        wheelListening = true;
        // Capture and not passive, so the knob gets the wheel before the
        // scroll and zoom handlers around it, and can stop the page scrolling.
        window.addEventListener("wheel", onWheel, {
          capture: true,
          passive: false,
        });
      }
      wheelKnobs.set(el, { v0, k, onValue });
    },
  };
}

export type KnobControl = ReturnType<typeof knobControl>;

/** "-3.5", "+2 dB", "−∞" → dB; NaN when it doesn't parse. */
export function parseDb(s: string): number {
  const t = s.replace(/−/g, "-").replace(/db/i, "").trim();
  if (/^-?(inf|∞)/i.test(t)) return -Infinity;
  return t === "" ? NaN : parseFloat(t);
}
