import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/stores/session-store";

/* Peaks of any span of a source, for the faint audio a trim leaves out
 * (clip waveforms themselves are `lib/wave-tiles`). Each source keeps an overview of its whole length, fetched once,
 * so any view can draw straight away; zoomed in past the overview, each
 * clip fetches a finer window around what it shows, wider than the screen
 * so scrolling stays inside it, and draws from the overview until that
 * lands. Fetches never stack: one per clip in flight, the latest wins. */

/** `(min, max)` pairs, `per` source frames each, from source frame `from`. */
interface Level {
  from: number;
  per: number;
  data: Float32Array;
}

/** Overview buckets: the most the engine gives in one call. */
const OVERVIEW_BUCKETS = 1 << 16;
/** Each coarser overview level merges this many buckets of the one below. */
const REDUCE = 8;

interface Overview {
  levels: Level[] | null;
  wait: Set<() => void>;
}

const overviews = new Map<string, Overview>();

function pow2Ceil(x: number): number {
  return 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, x))));
}

function pow2Floor(x: number): number {
  return 2 ** Math.max(0, Math.floor(Math.log2(Math.max(1, x))));
}

function coarser(l: Level): Level {
  const n = Math.ceil(l.data.length / 2 / REDUCE);
  const data = new Float32Array(2 * n);
  for (let b = 0; b < n; b++) {
    let lo = 0;
    let hi = 0;
    for (let j = b * REDUCE; j < Math.min((b + 1) * REDUCE, l.data.length / 2); j++) {
      lo = Math.min(lo, l.data[2 * j]);
      hi = Math.max(hi, l.data[2 * j + 1]);
    }
    data[2 * b] = lo;
    data[2 * b + 1] = hi;
  }
  return { from: l.from, per: l.per * REDUCE, data };
}

/** The source's overview levels, finest first; null until fetched, and
 * `onReady` runs once they are. */
function overview(tab: number | null, source: number, rev: number, frames: number, onReady: () => void): Level[] | null {
  // Each tab keeps its own: source ids repeat from one session to the next.
  const key = `${tab}:${source}:${rev}`;
  let o = overviews.get(key);
  if (!o) {
    // An older revision of the file is stale now.
    for (const k of overviews.keys()) if (k.startsWith(`${tab}:${source}:`)) overviews.delete(k);
    const entry: Overview = { levels: null, wait: new Set() };
    o = entry;
    overviews.set(key, entry);
    // Whole-frame, power-of-two buckets: every level's bucket edges sit on
    // the same frames, so swapping levels or windows never shifts the shape.
    const per = pow2Ceil(frames / OVERVIEW_BUCKETS);
    const n = Math.max(1, Math.ceil(frames / per));
    void api
      .peaks(tab, source, 0, n * per, n)
      .then((data) => {
        const levels: Level[] = [{ from: 0, per, data }];
        while (levels[levels.length - 1].data.length / 2 > 512) levels.push(coarser(levels[levels.length - 1]));
        entry.levels = levels;
        for (const f of entry.wait) f();
        entry.wait.clear();
      })
      .catch(() => overviews.delete(key));
  }
  if (!o.levels) o.wait.add(onReady);
  return o.levels;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function covers(l: Level, a: number, z: number): boolean {
  return l.from <= a + 0.5 && l.from + (l.data.length / 2) * l.per >= z - 0.5;
}

function minmax(l: Level, a: number, z: number): [number, number] | null {
  const n = l.data.length / 2;
  // Buckets wider than the span: interpolate between bucket centres, so the
  // shape slopes smoothly instead of stepping at bucket edges.
  if (z - a < l.per) {
    const u = ((a + z) / 2 - l.from) / l.per - 0.5;
    if (u < -0.5 || u > n - 0.5) return null;
    const b = clampInt(Math.floor(u), 0, n - 1);
    const c = Math.min(b + 1, n - 1);
    const t = Math.min(1, Math.max(0, u - b));
    return [l.data[2 * b] * (1 - t) + l.data[2 * c] * t, l.data[2 * b + 1] * (1 - t) + l.data[2 * c + 1] * t];
  }
  const b0 = Math.floor((a - l.from) / l.per);
  const b1 = Math.max(b0, Math.ceil((z - l.from) / l.per) - 1);
  let lo = 0;
  let hi = 0;
  let any = false;
  for (let b = Math.max(0, b0); b <= b1 && b < l.data.length / 2; b++) {
    lo = Math.min(lo, l.data[2 * b]);
    hi = Math.max(hi, l.data[2 * b + 1]);
    any = true;
  }
  return any ? [lo, hi] : null;
}

/** What a clip draws from: the peak of any span of source frames. */
export interface Peaks {
  /** Min and max over source frames `f0..f1` (as the clip counts them),
   * or null where nothing is known. */
  at(f0: number, f1: number): [number, number] | null;
}

class View implements Peaks {
  levels: Level[];
  detail: Level | null;
  mirror: number | null;
  constructor(levels: Level[], detail: Level | null, mirror: number | null) {
    this.levels = levels;
    this.detail = detail;
    this.mirror = mirror;
  }

  at(f0: number, f1: number): [number, number] | null {
    // A reversed clip counts from the source's end.
    const [a, z] = this.mirror === null ? [f0, f1] : [this.mirror - f1, this.mirror - f0];
    const span = Math.max(z - a, 1e-9);
    const d = this.detail;
    // A detail window much finer than a pixel costs more than it shows.
    if (d && d.per < this.levels[0].per && d.per >= span / 64 && covers(d, a, z)) return minmax(d, a, z);
    // The coarsest level with many buckets to the span: close to the true
    // peak, so stepping between levels as the zoom changes barely shows.
    let l = this.levels[0];
    for (const x of this.levels) if (x.per <= span / 32) l = x;
    return minmax(l, a, z);
  }
}

/** Peaks for source frames `from..to` drawn `buckets` px wide (a reversed
 * clip passes the source's length as `mirror`). Never waits on a fetch to
 * draw: what is cached now comes back, and the clip redraws as finer peaks
 * land. */
export function usePeaks(source: number, from: number, to: number, buckets: number, mirror: number | null = null): Peaks | null {
  const [, bump] = useState(0);
  const rev = useSession((s) => s.fileRev);
  const tab = useSession((s) => s.activeTab);
  const frames = useSession((s) => s.session?.sources.find((x) => x.id === source)?.frames ?? 0);
  const levels = overview(tab, source, rev, frames, () => bump((n) => n + 1));
  const [detail, setDetail] = useState<(Level & { key: string }) | null>(null);
  const have = useRef<(Level & { key: string }) | null>(null);
  const busy = useRef(false);
  const want = useRef({ a: 0, z: 0, per: 0 });
  const key = `${tab}:${source}:${rev}`;

  // In raw source frames.
  const [ra, rz] = mirror === null ? [from, to] : [mirror - to, mirror - from];
  const per = (rz - ra) / Math.max(1, buckets);

  useEffect(() => {
    want.current = { a: ra, z: rz, per };
    if (have.current && have.current.key !== key) have.current = null;
    const fetchDetail = () => {
      const ov = overview(tab, source, rev, frames, () => undefined);
      const { a, z, per } = want.current;
      if (!ov || busy.current || frames <= 0 || per <= 0) return;
      // The overview is fine enough.
      if (per >= ov[0].per) return;
      // Whole-frame, power-of-two buckets at about twice the screen's
      // resolution, so a zoom only refetches at each halving, and the
      // buckets of one fetch and the next share edges.
      // An octave finer than drawn, so a zoom in has the next width ready.
      const step = Math.min(pow2Floor(per / 4), ov[0].per / 2);
      const d = have.current;
      if (d && covers(d, a, z) && d.per <= Math.max(1, per / 2) && d.per >= step / 2) return;
      // A window three screens wide.
      const span = z - a;
      const mid = (a + z) / 2;
      const half = Math.min(1.5 * span, (OVERVIEW_BUCKETS / 2) * step);
      // On the overview's bucket grid, so the window's merged widths line up
      // with the overview's and switching between them shifts nothing.
      const grid = ov[0].per;
      const wa = Math.max(0, Math.floor((mid - half) / grid) * grid);
      const n = Math.max(1, Math.min(OVERVIEW_BUCKETS, Math.ceil((Math.min(frames, mid + half) - wa) / step)));
      const wz = wa + n * step;
      busy.current = true;
      void api
        .peaks(tab, source, wa, wz, n)
        .then((data) => {
          have.current = { key, from: wa, per: step, data };
          setDetail(have.current);
        })
        .catch(() => undefined)
        .finally(() => {
          busy.current = false;
          // The view moved on while this was in flight.
          fetchDetail();
        });
    };
    fetchDetail();
  });

  const d = detail?.key === key ? detail : null;
  return useMemo(() => (levels ? new View(levels, d, mirror) : null), [levels, d, mirror]);
}

// A closed tab's waveforms go with it.
useSession.subscribe((st, prev) => {
  if (st.tabs === prev.tabs) return;
  const open = new Set(st.tabs.map((t) => String(t.id)));
  for (const k of overviews.keys()) if (!open.has(k.split(":")[0])) overviews.delete(k);
});
