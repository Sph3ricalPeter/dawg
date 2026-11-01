import { clamp } from "@/lib/format";
import { onFrame } from "@/lib/frame-loop";
import { fppRange, maxStart, useSession } from "@/stores/session-store";

/** Seconds for a tween to cover ~63% of the way: short enough to feel
 * direct, long enough that wheel ticks glide instead of jump. */
const TAU = 0.045;

/** Eases `cur` toward `to` over `dt` seconds (an exponential ease-out, so
 * new wheel ticks just move the target and the motion stays continuous). */
export function ease(cur: number, to: number, dt: number): number {
  return cur + (to - cur) * (1 - Math.exp(-dt / TAU));
}

/* The time view's tween. It runs in "pivot" terms: `anchor` is the frame
 * shown at `px`, and the view's start is `anchor - px * fpp`, so the point
 * under the mouse stays put for the whole of a zoom. */
let px = 0;
let anchor = 0;
let anchorTo = 0;
let logFpp = 0;
let logFppTo = 0;
let stop: (() => void) | null = null;
/** The view this tween last wrote: anything else means someone else moved
 * it (fit, a drag, following the playhead), and the tween gives way. */
let wrote: { start: number; fpp: number } | null = null;

function settle() {
  stop?.();
  stop = null;
  wrote = null;
}

/** Starts from the view as it is, unless a tween is already under way. */
function sync(): boolean {
  const { view, session } = useSession.getState();
  if (!session) return false;
  if (stop && wrote && view.start === wrote.start && view.fpp === wrote.fpp) return true;
  settle();
  logFpp = logFppTo = Math.log(view.fpp);
  anchor = anchorTo = view.start + px * view.fpp;
  return true;
}

/** Moves the pivot to `x` px without moving anything on screen. */
function pivot(x: number) {
  const fpp = Math.exp(logFpp);
  const fppTo = Math.exp(logFppTo);
  anchor += (x - px) * fpp;
  anchorTo += (x - px) * fppTo;
  px = x;
}

/** Keeps the target inside the zoom range and the timeline. */
function clampTarget() {
  const { session, width } = useSession.getState();
  if (!session) return;
  const [lo, hi] = fppRange(session, width);
  logFppTo = clamp(logFppTo, Math.log(lo), Math.log(hi));
  const fpp = Math.exp(logFppTo);
  const start = clamp(anchorTo - px * fpp, 0, maxStart(session, width, fpp));
  anchorTo = start + px * fpp;
}

function frame(_now: number, dt: number) {
  const s = useSession.getState();
  if (!s.session || (wrote && (s.view.start !== wrote.start || s.view.fpp !== wrote.fpp))) {
    settle();
    return;
  }
  logFpp = ease(logFpp, logFppTo, dt);
  anchor = ease(anchor, anchorTo, dt);
  let fpp = Math.exp(logFpp);
  // Close enough: land exactly on the target and stop the loop.
  const done = Math.abs(logFppTo - logFpp) < 1e-3 && Math.abs(anchorTo - anchor) < 0.25 * fpp;
  if (done) {
    logFpp = logFppTo;
    anchor = anchorTo;
    fpp = Math.exp(logFpp);
  }
  const start = clamp(anchor - px * fpp, 0, maxStart(s.session, s.width, fpp));
  wrote = { start, fpp };
  useSession.setState({ view: wrote });
  if (done) settle();
}

function run() {
  clampTarget();
  if (!stop) stop = onFrame(frame);
}

/** Zooms time by `factor` around `x` px, smoothly. */
export function smoothZoom(x: number, factor: number) {
  if (!sync()) return;
  pivot(x);
  logFppTo += Math.log(factor);
  run();
}

/** Scrolls time by `dx` px (at the zoom it is heading to), smoothly. */
export function smoothScroll(dx: number) {
  if (!sync()) return;
  anchorTo += dx * Math.exp(logFppTo);
  run();
}

/** Smooth vertical scrolling for one element: wheel ticks add to a target
 * that `scrollTop` eases toward. Dragging the scrollbar (or anything else
 * setting `scrollTop`) takes over from the tween. */
export class SmoothScrollTop {
  private to = 0;
  private cur = 0;
  private stop: (() => void) | null = null;
  private el: HTMLElement;
  constructor(el: HTMLElement) {
    this.el = el;
  }

  by(dy: number) {
    const el = this.el;
    if (!this.stop || Math.abs(el.scrollTop - Math.round(this.cur)) > 1) {
      this.cancel();
      this.cur = this.to = el.scrollTop;
    }
    this.to = clamp(this.to + dy, 0, Math.max(0, el.scrollHeight - el.clientHeight));
    this.stop ??= onFrame((_now, dt) => {
      if (Math.abs(el.scrollTop - Math.round(this.cur)) > 1) return this.cancel();
      this.cur = ease(this.cur, this.to, dt);
      if (Math.abs(this.to - this.cur) < 0.5) this.cur = this.to;
      el.scrollTop = this.cur;
      if (this.cur === this.to) this.cancel();
    });
  }

  cancel() {
    this.stop?.();
    this.stop = null;
  }
}
