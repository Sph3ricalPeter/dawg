import { api } from "@/lib/api";
import { clamp, dbToGain, envelopeAt, fadeAt, srcAt } from "@/lib/format";
import { type ClipState } from "@/lib/api";
import { useSession } from "@/stores/session-store";
import { drawTile, TILE_W, type TileJob } from "@/lib/wave-draw";
import { alpha, token } from "@/ui/tokens";

/* Clip waveforms in the playlist, drawn the way DAWs draw them: from
 * precomputed min/max peaks at power-of-two zoom levels, rendered once into
 * small images ("tiles") fixed in time, and while the view scrolls or zooms
 * those images are only copied and scaled onto each clip's canvas. That is a
 * handful of image copies a clip per frame, which the GPU does for free,
 * instead of a long anti-aliased path filled per clip per frame.
 *
 * Level `L` has one peak per `2^L` source frames, one tile pixel each. At a
 * zoom between two levels the finer level is drawn shrunk and the coarser
 * one grown, cross-faded by how far between them the zoom is (what a GPU
 * does with mipmaps), so nothing pops when a level takes over and nothing
 * slides: every peak stays on the frames it was measured over.
 *
 * Zoomed in past one source frame a device pixel, the samples themselves
 * are drawn as a line, straight from the finest peaks. */

/** Tile width in device pixels (see `wave-draw`). */
const W = TILE_W;
/** Peaks fetched from the engine per call, at levels finer than the
 * overview. */
const CHUNK = 4096;
/** Most overview buckets the engine gives in one call. */
const OVERVIEW_BUCKETS = 1 << 16;
/** Image memory the tiles may use. */
const TILE_BYTES = 160 << 20;
/** Peak chunks kept (32 KB each). */
const MAX_CHUNKS = 512;
/** Time a frame may spend rendering new tiles; the rest wait a frame and
 * the clip draws a coarser tile in their place meanwhile. */
const BUDGET_MS = 5;
/** Engine calls in flight at once. */
const MAX_INFLIGHT = 3;

/* ---------- Peaks ---------- */

interface Source {
  key: string;
  tab: number | null;
  id: number;
  frames: number;
  /** The overview's level and its peaks; coarser levels merged from it. */
  ovL: number;
  levels: Float32Array[] | null;
  overviewAsked: boolean;
}

const sources = new Map<string, Source>();
/** Fetched chunks by `source|level|chunk`, oldest use first. */
const chunks = new Map<string, Float32Array>();
interface Want {
  src: Source;
  lv: number;
  c: number;
  at: number;
}
const queue = new Map<string, Want>();
const inflight = new Set<string>();

function sourceOf(tab: number | null, id: number, rev: number, frames: number): Source {
  const key = `${tab}:${id}:${rev}`;
  let s = sources.get(key);
  if (!s) {
    // An older revision of the file is stale now.
    for (const [k] of sources) if (k.startsWith(`${tab}:${id}:`)) sources.delete(k);
    for (const k of [...chunks.keys()]) if (k.startsWith(`${tab}:${id}:`)) chunks.delete(k);
    const per = 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, frames / OVERVIEW_BUCKETS))));
    s = { key, tab, id, frames, ovL: Math.log2(per), levels: null, overviewAsked: false };
    sources.set(key, s);
  }
  return s;
}

function halve(l: Float32Array): Float32Array {
  const n = Math.ceil(l.length / 4);
  const out = new Float32Array(2 * n);
  for (let b = 0; b < n; b++) {
    const j = 2 * b;
    const k = Math.min(j + 1, l.length / 2 - 1);
    out[2 * b] = Math.min(l[2 * j], l[2 * k]);
    out[2 * b + 1] = Math.max(l[2 * j + 1], l[2 * k + 1]);
  }
  return out;
}

function askOverview(s: Source) {
  if (s.overviewAsked || s.frames <= 0) return;
  s.overviewAsked = true;
  const per = 2 ** s.ovL;
  const n = Math.max(1, Math.ceil(s.frames / per));
  void api
    .peaks(s.tab, s.id, 0, n * per, n)
    .then((data) => {
      const levels: Float32Array[] = [data];
      while (levels[levels.length - 1].length > 2) levels.push(halve(levels[levels.length - 1]));
      s.levels = levels;
      redrawAll();
    })
    .catch(() => {
      s.overviewAsked = false;
    });
}

/** The coarsest level there is: one bucket for the whole source. */
function maxLevel(s: Source): number {
  return s.levels ? s.ovL + s.levels.length - 1 : s.ovL + 16;
}

function pump() {
  const now = performance.now();
  while (inflight.size < MAX_INFLIGHT && queue.size) {
    // Latest asked first: that's what's on screen now.
    let best: [string, Want] | null = null;
    for (const e of queue) {
      if (now - e[1].at > 1000) queue.delete(e[0]);
      else if (!best || e[1].at > best[1].at) best = e;
    }
    if (!best) return;
    const [key, { src, lv, c }] = best;
    queue.delete(key);
    inflight.add(key);
    const per = 2 ** lv;
    const from = c * CHUNK * per;
    void api
      .peaks(src.tab, src.id, from, from + CHUNK * per, CHUNK)
      .then((data) => {
        if (sources.get(src.key) !== src) return;
        chunks.set(key, data);
        while (chunks.size > MAX_CHUNKS) chunks.delete(chunks.keys().next().value!);
        redrawAll();
      })
      .catch(() => undefined)
      .finally(() => {
        inflight.delete(key);
        pump();
      });
  }
}

/** `n` (min, max) pairs of level `lv` from bucket `b0` (out of range ones
 * silent), or null while some aren't loaded yet; asks for those (`lag` ms
 * behind what's asked now, for a prefetch). */
function buckets(s: Source, lv: number, b0: number, n: number, lag = 0): Float32Array | null {
  const out = new Float32Array(2 * n);
  if (lv >= s.ovL) {
    if (!s.levels) {
      askOverview(s);
      return null;
    }
    const l = s.levels[Math.min(lv - s.ovL, s.levels.length - 1)];
    const len = l.length / 2;
    const a = Math.max(0, b0);
    const z = Math.min(len, b0 + n);
    if (z > a) out.set(l.subarray(2 * a, 2 * z), 2 * (a - b0));
    return out;
  }
  const per = 2 ** lv;
  const last = Math.ceil(s.frames / per) - 1;
  const a = Math.max(0, b0);
  const z = Math.min(last, b0 + n - 1);
  let ok = true;
  for (let c = Math.floor(a / CHUNK); c <= Math.floor(z / CHUNK); c++) {
    const key = `${s.key}|${lv}|${c}`;
    const d = chunks.get(key);
    if (!d) {
      ok = false;
      if (!inflight.has(key)) queue.set(key, { src: s, lv, c, at: performance.now() - lag });
      continue;
    }
    // Recently used: to the back of the eviction order.
    chunks.delete(key);
    chunks.set(key, d);
    if (!ok) continue;
    const ca = Math.max(a, c * CHUNK);
    const cz = Math.min(z, (c + 1) * CHUNK - 1);
    out.set(d.subarray(2 * (ca - c * CHUNK), 2 * (cz - c * CHUNK + 1)), 2 * (ca - b0));
  }
  if (!ok) {
    pump();
    return null;
  }
  return out;
}

/* ---------- Tiles ---------- */

interface Tile {
  bmp: ImageBitmap;
  /** What it was drawn for: the clip's look and the tile's height. */
  shape: string;
  h: number;
}

const tiles = new Map<string, Tile>();
let tileBytes = 0;

function putTile(key: string, t: Tile) {
  const old = tiles.get(key);
  if (old) {
    tileBytes -= old.bmp.width * old.bmp.height * 4;
    old.bmp.close();
    tiles.delete(key);
  }
  tiles.set(key, t);
  tileBytes += t.bmp.width * t.bmp.height * 4;
  while (tileBytes > TILE_BYTES && tiles.size > 1) {
    const [k, v] = tiles.entries().next().value!;
    tiles.delete(k);
    tileBytes -= v.bmp.width * v.bmp.height * 4;
    v.bmp.close();
  }
}

function getTile(key: string): Tile | undefined {
  const t = tiles.get(key);
  if (t) {
    tiles.delete(key);
    tiles.set(key, t);
  }
  return t;
}

/** What changes how a clip's tiles look. Where it has no fades or envelope
 * its position and trim don't, so moving or trimming it keeps its tiles. */
function shapeOf(clip: ClipState, src: Source): string {
  const plain = clip.fadeIn === 0 && clip.fadeOut === 0 && clip.envelope.length === 0;
  const base = `${src.key}|${clip.gainDb}|${clip.reversed ? 1 : 0}`;
  if (plain) return base;
  return `${base}|${clip.offset}|${clip.len}|${clip.stretch}|${clip.fadeIn}|${clip.fadeOut}|${clip.fadeInCurve}|${clip.fadeOutCurve}|${JSON.stringify(clip.envelope)}`;
}

/** The clip's level at source frame `u` (as the clip counts them). */
function gainAt(clip: ClipState, gain: number, plain: boolean, u: number): number {
  if (plain) return gain;
  const rel = clamp((u - clip.offset) * clip.stretch, 0, clip.len - 1);
  return gain * fadeAt(clip, rel) * envelopeAt(clip.envelope, srcAt(clip, rel));
}

/** The peaks and levels tile `k` of level `lv` is drawn from, or null
 * until its peaks are loaded (they're asked for). */
function jobFor(clip: ClipState, src: Source, lv: number, k: number, H: number, dpr: number, lag: number): TileJob | null {
  const per = 2 ** lv;
  // One bucket each side for the seam gutters, one more for the outline's
  // slope into them.
  const b0 = k * W - 2;
  const n = W + 4;
  const d = buckets(src, lv, b0, n, lag);
  if (!d) return null;
  const mirror = clip.reversed ? src.frames : null;
  const plain = clip.fadeIn === 0 && clip.fadeOut === 0 && clip.envelope.length === 0;
  const gain = dbToGain(clip.gainDb);
  const gs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const rc = (b0 + i + 0.5) * per;
    gs[i] = gainAt(clip, gain, plain, mirror === null ? rc : mirror - rc);
  }
  return { lv, h: H, dpr, d, gs, fill: alpha("--edge", 0.2), body: alpha("--edge", 0.8), over: token("--danger") };
}

/* Tiles are drawn by a few workers; until one lands, the clip shows what it
 * has (the tile's old look, or part of a coarser or finer tile). Where
 * workers can't draw on a canvas, the main thread does, a few ms a frame. */

const WORKERS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
/** Tiles being drawn at once, per worker. */
const PER_WORKER = 3;
let workers: Worker[] | null = null;
let noWorkers = typeof OffscreenCanvas === "undefined" || typeof Worker === "undefined";
interface Job {
  key: string;
  stamp: string;
  shape: string;
  h: number;
  at: number;
  job: TileJob;
}
/** Tiles waiting for a worker, by key; the latest ask for a key wins. */
const jobs = new Map<string, Job>();
/** Tiles a worker is drawing, by id. */
const drawing = new Map<number, Job & { worker: number }>();
/** What's being drawn per tile key, so it isn't asked for twice. */
const drawingStamp = new Map<string, string>();
const busy: number[] = [];
let jobSeq = 0;

function startWorkers(): Worker[] | null {
  if (workers || noWorkers) return workers;
  try {
    workers = [];
    for (let i = 0; i < WORKERS; i++) {
      const wk = new Worker(new URL("./wave-worker.ts", import.meta.url), { type: "module" });
      const idx = i;
      wk.onmessage = (e: MessageEvent<{ id: number; bmp: ImageBitmap }>) => {
        const j = drawing.get(e.data.id);
        drawing.delete(e.data.id);
        busy[idx]--;
        if (j) {
          if (drawingStamp.get(j.key) === j.stamp) drawingStamp.delete(j.key);
          putTile(j.key, { bmp: e.data.bmp, shape: j.shape, h: j.h });
          redrawAll();
        } else e.data.bmp.close();
        dispatch();
      };
      wk.onerror = () => {
        // No canvas in workers here: the main thread draws from now on.
        noWorkers = true;
        for (const w of workers ?? []) w.terminate();
        workers = null;
        drawing.clear();
        drawingStamp.clear();
        jobs.clear();
        redrawAll();
      };
      workers.push(wk);
      busy.push(0);
    }
  } catch {
    noWorkers = true;
    workers = null;
  }
  return workers;
}

function dispatch() {
  const ws = workers;
  if (!ws) return;
  const now = performance.now();
  for (;;) {
    let wi = -1;
    for (let i = 0; i < ws.length; i++) if (busy[i] < PER_WORKER && (wi < 0 || busy[i] < busy[wi])) wi = i;
    if (wi < 0) return;
    let best: Job | null = null;
    for (const j of jobs.values()) {
      // Asked for a while ago and not since: off screen by now.
      if (now - j.at > 1500) jobs.delete(j.key);
      else if (!best || j.at > best.at) best = j;
    }
    if (!best) return;
    jobs.delete(best.key);
    const id = ++jobSeq;
    drawing.set(id, { ...best, worker: wi });
    drawingStamp.set(best.key, best.stamp);
    busy[wi]++;
    ws[wi].postMessage({ ...best.job, id }, [best.job.d.buffer, best.job.gs.buffer]);
  }
}

let scratch: OffscreenCanvas | null = null;

/** Draws a tile on the main thread, for where workers can't. */
function drawHere(job: TileJob): ImageBitmap {
  scratch ??= new OffscreenCanvas(W + 2, job.h);
  if (scratch.height !== job.h) scratch.height = job.h;
  drawTile(scratch.getContext("2d")!, job);
  return scratch.transferToImageBitmap();
}

/** Asks for tile `key` (tile `k` of level `lv`) to be drawn as `shape`, `H`
 * device pixels tall; `lag` ms behind what's on screen, for one that's only
 * likely to be needed soon. On the main thread, it may be drawn at once
 * (true). */
function want(key: string, clip: ClipState, src: Source, lv: number, k: number, H: number, dpr: number, shape: string, lag: number): boolean {
  const stamp = `${shape}|${H}`;
  if (drawingStamp.get(key) === stamp) return false;
  const queued = jobs.get(key);
  if (queued && queued.stamp === stamp) {
    queued.at = Math.max(queued.at, performance.now() - lag);
    return false;
  }
  if (startWorkers()) {
    const job = jobFor(clip, src, lv, k, H, dpr, lag);
    if (!job) return false;
    jobs.set(key, { key, stamp, shape, h: H, at: performance.now() - lag, job });
    dispatch();
    return false;
  }
  if (lag > 0 || spent >= BUDGET_MS) return false;
  const t0 = performance.now();
  const job = jobFor(clip, src, lv, k, H, dpr, 0);
  if (job) putTile(key, { bmp: drawHere(job), shape, h: H });
  spent += performance.now() - t0;
  return !!job;
}

/* ---------- Drawing ---------- */

let spent = 0;
let epoch = 0;

/** Clips that asked to be drawn again (a tile waited, or peaks landed). */
const painters = new Set<() => void>();
const pending = new Set<() => void>();
let raf = 0;

function later(fn: () => void) {
  pending.add(fn);
  raf ||= requestAnimationFrame(() => {
    raf = 0;
    const fns = [...pending];
    pending.clear();
    for (const f of fns) f();
  });
}

function redrawAll() {
  for (const p of painters) later(p);
}

/** Registers a clip's redraw, for when its peaks land; returns the
 * unregister. */
export function onWaveReady(fn: () => void): () => void {
  painters.add(fn);
  return () => {
    painters.delete(fn);
    pending.delete(fn);
  };
}

export interface WaveSource {
  tab: number | null;
  id: number;
  rev: number;
  frames: number;
}

/** Draws a clip's waveform on `x` (in CSS pixels), `w` by `h`, the canvas
 * starting at timeline frame `f0` at `fpp` frames a pixel. `again` is
 * called on a later frame if some of it had to wait. */
export function paintWave(
  x: CanvasRenderingContext2D,
  w: number,
  h: number,
  clip: ClipState,
  f0: number,
  fpp: number,
  ws: WaveSource,
  again: () => void,
) {
  if (ws.frames <= 0 || w <= 0 || h <= 0) return;
  const now = performance.now();
  if (now - epoch > 8) {
    epoch = now;
    spent = 0;
  }
  const src = sourceOf(ws.tab, ws.id, ws.rev, ws.frames);
  const dpr = window.devicePixelRatio || 1;
  const H = Math.max(1, Math.round(h * dpr));
  const mirror = clip.reversed ? src.frames : null;
  // CSS x of source frame `r` (raw, from the file's start).
  const k = clip.stretch / fpp;
  const xOf = (r: number) => (clip.start + ((mirror === null ? r : mirror - r) - clip.offset) * clip.stretch - f0) / fpp;
  // What of the clip is on this canvas, in raw source frames.
  const cx0 = Math.max(0, (clip.start - f0) / fpp);
  const cx1 = Math.min(w, (clip.start + clip.len - f0) / fpp);
  if (cx1 <= cx0) return;
  const uA = clip.offset + (f0 + cx0 * fpp - clip.start) / clip.stretch;
  const uZ = clip.offset + (f0 + cx1 * fpp - clip.start) / clip.stretch;
  const [rA, rZ] = mirror === null ? [uA, uZ] : [mirror - uZ, mirror - uA];

  x.save();
  x.beginPath();
  x.rect(cx0, 0, cx1 - cx0, h);
  x.clip();
  // Drawn on the main thread over this frame's budget: the rest on the
  // next. (Tiles from workers and peaks landing redraw every clip.)
  let waiting = false;

  // Source frames a device pixel.
  const sppd = 1 / (k * dpr);
  if (sppd < 1 && drawSamples(x, h, clip, src, rA, rZ, xOf, fpp)) {
    x.restore();
    return;
  }

  const shape = shapeOf(clip, src);
  const top = maxLevel(src);
  const lg = Math.log2(Math.max(1, sppd));
  let L = Math.min(top, Math.floor(lg));
  let t = L >= top ? 0 : lg - L;
  if (L < 0) {
    L = 0;
    t = 0;
  }
  // The coarser level takes over in the first part of the octave: a finer
  // level shrunk much below its size loses its thinnest peaks to the
  // filtering and looks washed out, a coarser one grown a little stays solid.
  t = Math.min(1, t / 0.6);
  t = t * t * (3 - 2 * t);
  const snap = (v: number) => Math.round(v * dpr) / dpr;

  const drawLevel = (lv: number, alpha: number) => {
    if (alpha <= 0.002) return;
    x.globalAlpha = alpha;
    const span = W * 2 ** lv;
    const kA = Math.floor(rA / span);
    const kZ = Math.floor((rZ - 1e-9) / span);
    for (let tk = kA; tk <= kZ; tk++) {
      let xa = snap(xOf(tk * span));
      let xb = snap(xOf((tk + 1) * span));
      if (xb < xa) [xa, xb] = [xb, xa];
      if (xb <= cx0 || xa >= cx1) continue;
      const blit = (bmp: ImageBitmap, sx: number, sw: number) => {
        if (mirror === null) x.drawImage(bmp, sx, 0, sw, bmp.height, xa, 0, xb - xa, h);
        else {
          x.save();
          x.translate(xa + xb, 0);
          x.scale(-1, 1);
          x.drawImage(bmp, sx, 0, sw, bmp.height, xa, 0, xb - xa, h);
          x.restore();
        }
      };
      const key = `${ws.tab}:${clip.id}|${lv}|${tk}`;
      let tile = getTile(key);
      if (!tile || tile.shape !== shape || tile.h !== H) {
        if (want(key, clip, src, lv, tk, H, dpr, shape, 0)) tile = getTile(key);
        else waiting = true;
      }
      if (tile) {
        // Up to date, or its old look until the new one lands.
        blit(tile.bmp, 1, W);
        continue;
      }
      // Meanwhile: part of a coarser tile, or the two finer ones it covers.
      let shown = false;
      for (let j = 1; j <= 6 && !shown; j++) {
        const c = getTile(`${ws.tab}:${clip.id}|${lv + j}|${Math.floor(tk / 2 ** j)}`);
        if (c) {
          const part = W / 2 ** j;
          blit(c.bmp, 1 + (tk - Math.floor(tk / 2 ** j) * 2 ** j) * part, part);
          shown = true;
        }
      }
      if (!shown && lv > 0) {
        const a = getTile(`${ws.tab}:${clip.id}|${lv - 1}|${2 * tk}`);
        const b = getTile(`${ws.tab}:${clip.id}|${lv - 1}|${2 * tk + 1}`);
        if (a && b) {
          const xm = (xa + xb) / 2;
          const [l, r] = mirror === null ? [a, b] : [b, a];
          const blitTo = (bmp: ImageBitmap, from: number, to: number) => {
            if (mirror === null) x.drawImage(bmp, 1, 0, W, bmp.height, from, 0, to - from, h);
            else {
              x.save();
              x.translate(from + to, 0);
              x.scale(-1, 1);
              x.drawImage(bmp, 1, 0, W, bmp.height, from, 0, to - from, h);
              x.restore();
            }
          };
          blitTo(l.bmp, xa, xm);
          blitTo(r.bmp, xm, xb);
        }
      }
      continue;
    }
  };

  drawLevel(L, 1 - t);
  // Added on, so the two levels' coverage sums to the one look.
  x.globalCompositeOperation = "lighter";
  drawLevel(Math.min(top, L + 1), t);
  x.globalCompositeOperation = "source-over";
  x.globalAlpha = 1;
  x.restore();
  // Drawn ahead, behind what's on screen: the level a zoom in or out goes
  // to next, and a tile past each edge for a scroll.
  if (!noWorkers && tileBytes < TILE_BYTES * 0.6) {
    const ahead = (lv: number, extra: number) => {
      if (lv < 0 || lv > top) return;
      const span = W * 2 ** lv;
      for (let tk = Math.floor(rA / span) - extra; tk <= Math.floor((rZ - 1e-9) / span) + extra; tk++) {
        if (tk < 0 || tk * span >= src.frames) continue;
        const key = `${ws.tab}:${clip.id}|${lv}|${tk}`;
        const tile = tiles.get(key);
        if (!tile || tile.shape !== shape || tile.h !== H) want(key, clip, src, lv, tk, H, dpr, shape, 300);
      }
    };
    ahead(L, 1);
    ahead(L + 1, 1);
    ahead(L - 1, 0);
    ahead(L + 2, 0);
  }
  if (waiting && noWorkers) later(again);
}

/** Zoomed in past a frame a device pixel: the samples, joined by a line
 * (dots too once they're far apart), as other editors draw them. False if
 * they aren't loaded yet. */
function drawSamples(
  x: CanvasRenderingContext2D,
  h: number,
  clip: ClipState,
  src: Source,
  rA: number,
  rZ: number,
  xOf: (r: number) => number,
  fpp: number,
): boolean {
  const a = Math.floor(rA) - 1;
  const n = Math.ceil(rZ) + 2 - a;
  const d = buckets(src, 0, a, n);
  if (!d) return false;
  const mid = h / 2;
  const half = h / 2 - 2;
  const plain = clip.fadeIn === 0 && clip.fadeOut === 0 && clip.envelope.length === 0;
  const gain = dbToGain(clip.gainDb);
  const mirror = clip.reversed ? src.frames : null;
  const pts = new Float32Array(2 * n);
  const over: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = a + i;
    // One frame per bucket: min and max are its peak sample either way; the
    // larger magnitude keeps a stereo file's shape.
    const v = -d[2 * i] > d[2 * i + 1] ? d[2 * i] : d[2 * i + 1];
    // A sample sits at its frame's start (reversed, its end).
    const g = v * gainAt(clip, gain, plain, mirror === null ? r : mirror - 1 - r);
    const px = mirror === null ? xOf(r) : xOf(r + 1);
    if (Math.abs(g) > 1) over.push(Math.round(px));
    pts[2 * i] = px;
    pts[2 * i + 1] = mid - clamp(g, -1, 1) * half;
  }
  x.strokeStyle = alpha("--edge", 0.85);
  x.lineWidth = 1.5;
  x.lineJoin = "round";
  x.beginPath();
  for (let i = 0; i < n; i++) (i ? x.lineTo : x.moveTo).call(x, pts[2 * i], pts[2 * i + 1]);
  x.stroke();
  if (fpp / clip.stretch < 1 / 8) {
    x.fillStyle = alpha("--edge", 0.85);
    for (let i = 0; i < n; i++) x.fillRect(pts[2 * i] - 1.5, pts[2 * i + 1] - 1.5, 3, 3);
  }
  x.fillStyle = token("--danger");
  for (const i of over) {
    x.fillRect(i, 1, 1, 2);
    x.fillRect(i, h - 3, 1, 2);
  }
  return true;
}

// A closed tab's waveforms go with it.
useSession.subscribe((st, prev) => {
  if (st.tabs === prev.tabs) return;
  const open = new Set(st.tabs.map((t) => String(t.id)));
  const gone = (k: string) => !open.has(k.split(":")[0]);
  for (const k of [...sources.keys()]) if (gone(k)) sources.delete(k);
  for (const k of [...chunks.keys()]) if (gone(k)) chunks.delete(k);
  for (const [k, v] of [...tiles]) {
    if (gone(k)) {
      tiles.delete(k);
      tileBytes -= v.bmp.width * v.bmp.height * 4;
      v.bmp.close();
    }
  }
});
