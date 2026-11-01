/** One requestAnimationFrame loop that every animated visual shares: the
 * playhead, the meters, the EQ analyser and the preview's playhead. Each
 * draws straight to its element or canvas at the monitor's refresh rate,
 * outside React, and the loop only runs while something is subscribed. */

type FrameFn = (now: number, dt: number) => void;

const subs = new Set<FrameFn>();
let raf = 0;
let last = 0;

function tick(now: number) {
  // Seconds since the last frame, capped so a stalled tab doesn't make
  // everything fall at once when it comes back.
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  for (const fn of [...subs]) {
    try {
      fn(now, dt);
    } catch (e) {
      console.error(e);
    }
  }
  raf = subs.size ? requestAnimationFrame(tick) : 0;
  if (!raf) last = 0;
}

/** Calls `fn` once per displayed frame until the returned function is
 * called. `now` is the rAF timestamp in ms, `dt` seconds since the last
 * frame. */
export function onFrame(fn: FrameFn): () => void {
  subs.add(fn);
  if (!raf) raf = requestAnimationFrame(tick);
  return () => {
    subs.delete(fn);
  };
}

/** Runs `fn` at most every `ms`, from the frame loop, never overlapping:
 * for polling the engine. */
export function everyFrameAtMost(ms: number, fn: () => Promise<unknown> | void): () => void {
  let busy = false;
  let lastRun = -Infinity;
  return onFrame((now) => {
    if (busy || now - lastRun < ms) return;
    lastRun = now;
    const r = fn();
    if (r instanceof Promise) {
      busy = true;
      void r.finally(() => {
        busy = false;
      });
    }
  });
}

/** Rounds a CSS px position to the nearest device pixel, so two elements
 * at the same position land on the same pixel column at any display
 * scaling. */
export function snapPx(x: number): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.round(x * dpr) / dpr;
}

/** A position that moves at a steady rate between engine reports: reads in
 * between extrapolate from the last report, and each report nudges it back
 * in line instead of jumping, so it moves smoothly at the display's rate. A
 * report far from the guess (a seek, a restart) snaps to it. */
export class Clock {
  private pos = 0;
  private at = 0;
  private running = false;
  /** Units per second. */
  rate: number;
  /** Where a raw extrapolated position really is (loop, end). */
  private wrap: (pos: number) => number;
  /** Reports further off than this many seconds snap. */
  private snapSec: number;

  constructor(rate = 1, wrap: (pos: number) => number = (p) => p, snapSec = 0.15) {
    this.rate = rate;
    this.wrap = wrap;
    this.snapSec = snapSec;
  }

  setWrap(wrap: (pos: number) => number) {
    this.wrap = wrap;
  }

  /** Starts (or restarts) from `pos`, now. */
  reset(pos: number, running = true) {
    this.pos = pos;
    this.at = performance.now();
    this.running = running;
  }

  stop() {
    this.running = false;
  }

  /** Where the position is at time `now` (performance.now ms). */
  read(now = performance.now()): number {
    if (!this.running) return this.pos;
    return this.wrap(this.pos + ((now - this.at) / 1000) * this.rate);
  }

  /** The engine says the position is `pos`; `period` is the loop length for
   * telling a wrap from a jump, if looping. */
  report(pos: number, period: number | null = null, now = performance.now()) {
    if (!this.running) {
      this.reset(pos);
      return;
    }
    const guess = this.read(now);
    let err = pos - guess;
    // Just past a loop's end the report may not have wrapped yet, or the
    // guess not: the smaller way round is the real difference.
    if (period && period > 0) {
      err = ((((err + period / 2) % period) + period) % period) - period / 2;
    }
    if (Math.abs(err) > this.snapSec * this.rate) {
      this.pos = pos;
    } else {
      // Reports come in blocks of an audio buffer and a poll late, so each
      // one only pulls the guess part of the way.
      this.pos = guess + err * 0.12;
    }
    this.at = now;
  }
}

/** How fast the level meters fall back, in dB per second. */
export const METER_FALL_DB = 80;

/** Peak-meter ballistics in dB: rises to `target` fast, falls back at a
 * steady `fallDbPerSec`. */
export function meterStep(shown: number, target: number, dt: number, fallDbPerSec: number, riseSec = 0.012): number {
  if (target >= shown) return shown + (target - shown) * Math.min(1, dt / riseSec);
  return Math.max(target, shown - fallDbPerSec * dt);
}

/** Linear peak to dB, with silence as a floor well below any meter. */
export function toDb(peak: number, floor = -120): number {
  return peak > 0 ? Math.max(floor, 20 * Math.log10(peak)) : floor;
}
