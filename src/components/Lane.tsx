import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ClipState, type EnvPoint, type TrackState } from "@/lib/api";
import { startDrag } from "@/lib/drag";
import { clamp, dbToGain, envelopeAt, fadeAt, fmtDb, fmtMs, stem } from "@/lib/format";
import { ENV_MAX, envY, trackColor } from "@/lib/timeline";
import { MIN_LEN, allClips, useSession, type View } from "@/stores/session-store";

const TITLE_H = 14;
/** Grab width of the trim zones at each clip edge. */
const EDGE = 6;
/** A moved clip snaps to other clips' edges, 0 and the playhead within this
 * many pixels (Alt skips it). */
const SNAP_PX = 8;
/** The envelope line takes clicks this many pixels either side of it. */
const ENV_BAND = 4;

/** `hex` scaled towards black by `k` (0 to 1). */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(v * k);
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

interface Peaks {
  /** Source frame of the first bucket, and frames per bucket. */
  from: number;
  per: number;
  data: Float32Array;
}

/** Min/max peaks over source frames `from..to`, refetched when they change. */
function usePeaks(source: number, from: number, to: number, buckets: number): Peaks | null {
  const [peaks, setPeaks] = useState<(Peaks & { key: string }) | null>(null);
  const fileRev = useSession((s) => s.fileRev);
  const key = `${source}:${fileRev}`;
  const a = Math.max(0, Math.floor(from));
  const z = Math.max(a + 1, Math.ceil(to));
  const n = Math.max(1, Math.ceil(buckets));
  useEffect(() => {
    let live = true;
    const raf = requestAnimationFrame(() => {
      void api
        .peaks(source, a, z, n)
        .then((data) => {
          if (live) setPeaks({ key, from: a, per: (z - a) / n, data });
        })
        .catch(() => undefined);
    });
    return () => {
      live = false;
      cancelAnimationFrame(raf);
    };
  }, [key, source, a, z, n]);
  return peaks && peaks.key === key ? peaks : null;
}

/** Peak amplitude (min, max) of the source frames one pixel covers. */
function peakAt(peaks: Peaks, f0: number, f1: number): [number, number] | null {
  const b0 = Math.floor((f0 - peaks.from) / peaks.per);
  const b1 = Math.max(b0, Math.ceil((f1 - peaks.from) / peaks.per) - 1);
  let lo = 0;
  let hi = 0;
  let any = false;
  for (let b = Math.max(0, b0); b <= b1 && b < peaks.data.length / 2; b++) {
    lo = Math.min(lo, peaks.data[2 * b]);
    hi = Math.max(hi, peaks.data[2 * b + 1]);
    any = true;
  }
  return any ? [lo, hi] : null;
}

function setupCanvas(canvas: HTMLCanvasElement, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const x = canvas.getContext("2d");
  x?.setTransform(dpr, 0, 0, dpr, 0, 0);
  x?.clearRect(0, 0, w, h);
  return x;
}

/** Waveform, fades and envelope of one clip, `w` px wide starting at timeline
 * frame `f0`. */
function drawClip(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  clip: ClipState,
  f0: number,
  fpp: number,
  peaks: Peaks | null,
  showEnv: boolean,
) {
  const x = setupCanvas(canvas, w, h);
  if (!x) return;
  const mid = h / 2;
  const half = h / 2 - 2;
  const gain = dbToGain(clip.gainDb);
  const over: number[] = [];
  if (peaks) {
    // Zoomed out, a smoothed outline like the mockup; zoomed in, the real
    // min/max so single cycles show.
    const outline = fpp > 24;
    const lo = new Float32Array(w);
    const hi = new Float32Array(w);
    const gains = new Float32Array(w);
    for (let i = 0; i < w; i++) {
      const t0 = f0 + i * fpp;
      const rel0 = t0 - clip.start;
      const p = peakAt(peaks, clip.offset + rel0, clip.offset + rel0 + fpp);
      if (!p) continue;
      [lo[i], hi[i]] = p;
      if (outline) {
        const a = Math.max(-lo[i], hi[i]);
        lo[i] = -a;
        hi[i] = a;
      }
      const rel = clamp(rel0 + fpp / 2, 0, clip.len - 1);
      gains[i] = gain * fadeAt(clip, rel) * envelopeAt(clip.envelope, clip.offset + rel);
    }
    if (outline) {
      const a = Float32Array.from(hi);
      for (let i = 0; i < w; i++) {
        let m = 0;
        let k = 0;
        for (let j = Math.max(0, i - 2); j <= Math.min(w - 1, i + 2); j++) {
          m += a[j];
          k++;
        }
        hi[i] = m / k;
        lo[i] = -hi[i];
      }
    }
    const bar = (i: number, l: number, hh: number) => x.fillRect(i, mid - hh * half, 1, Math.max(1, (hh - l) * half));
    for (let i = 0; i < w; i++) {
      x.fillStyle = "rgba(16,16,16,.2)";
      bar(i, lo[i], hi[i]);
      const plo = lo[i] * gains[i];
      const phi = hi[i] * gains[i];
      x.fillStyle = "rgba(16,16,16,.8)";
      bar(i, Math.max(-1, plo), Math.min(1, phi));
      if (phi > 1 || plo < -1) over.push(i);
    }
  }
  // Anything over full scale.
  x.fillStyle = "#ff4d4d";
  for (const i of over) {
    x.fillRect(i, 1, 1, 2);
    x.fillRect(i, h - 3, 1, 2);
  }

  // Fades: shade outside the diagonal.
  const px = (f: number) => (f - f0) / fpp;
  const cx0 = px(clip.start);
  const cx1 = px(clip.start + clip.len);
  x.fillStyle = "rgba(0,0,0,.28)";
  x.strokeStyle = "rgba(0,0,0,.4)";
  x.lineWidth = 1;
  const fade = (edge: number, inner: number) => {
    x.beginPath();
    x.moveTo(edge, 0);
    x.lineTo(inner, 0);
    x.lineTo(edge, h);
    x.closePath();
    x.fill();
    x.beginPath();
    x.moveTo(edge, h);
    x.lineTo(inner, 0);
    x.stroke();
  };
  if (clip.fadeIn > 0) fade(cx0, px(clip.start + clip.fadeIn));
  if (clip.fadeOut > 0) fade(cx1, px(clip.start + clip.len - clip.fadeOut));

  // The envelope line.
  if (showEnv) {
    x.strokeStyle = "rgba(18,18,18,.88)";
    x.lineWidth = 1.5;
    x.beginPath();
    for (let i = 0; i <= w; i += 2) {
      const rel = clamp(f0 + i * fpp - clip.start, 0, clip.len - 1);
      const y = envY(envelopeAt(clip.envelope, clip.offset + rel), h);
      if (i === 0) x.moveTo(i, y);
      else x.lineTo(i, y);
    }
    x.stroke();
  }
}

/** The source audio a trim leaves out, drawn faintly behind the clip. */
function Ghost({ clip, view, width, height }: { clip: ClipState; view: View; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frames = useSession((s) => s.session?.sources.find((x) => x.id === clip.source)?.frames ?? 0);
  const shift = clip.start - clip.offset;
  const x0 = clamp((shift - view.start) / view.fpp, 0, width);
  const x1 = clamp((shift + frames - view.start) / view.fpp, 0, width);
  const w = Math.ceil(x1 - x0);
  const f0 = view.start + x0 * view.fpp;
  const peaks = usePeaks(clip.source, f0 - shift, f0 - shift + w * view.fpp, w);
  useEffect(() => {
    const c = ref.current;
    if (!c || w <= 0) return;
    const h = height - TITLE_H - 5;
    const x = setupCanvas(c, w, h);
    if (!x || !peaks) return;
    x.fillStyle = "rgba(255,255,255,.13)";
    for (let i = 0; i < w; i++) {
      const t = f0 + i * view.fpp;
      if (t + view.fpp > clip.start && t < clip.start + clip.len) continue;
      const p = peakAt(peaks, t - shift, t - shift + view.fpp);
      if (!p) continue;
      const a = Math.max(-p[0], p[1]);
      x.fillRect(i, h / 2 - a * (h / 2 - 2), 1, Math.max(1, 2 * a * (h / 2 - 2)));
    }
  }, [w, height, peaks, f0, view.fpp, shift, clip.start, clip.len]);
  if (w <= 0) return null;
  return <canvas ref={ref} className="ghostcv" style={{ left: x0, top: 2 + TITLE_H }} />;
}

/** Timeline frames worth snapping to: 0, the playhead and the edges of every
 * clip not being moved. */
function snapPoints(exclude: number[]): number[] {
  const s = useSession.getState();
  const out = [0, s.playhead];
  if (s.session) {
    for (const { clip } of allClips(s.session)) {
      if (!exclude.includes(clip.id)) out.push(clip.start, clip.start + clip.len);
    }
  }
  return out;
}

/** A selection rectangle from a press until release, as in the mockup: it
 * selects every clip it touches. With `add`, on top of the selection there
 * was. A plain click runs `onClick`. */
function startMarquee(e: React.PointerEvent, add: boolean, onClick: () => void) {
  const store = useSession.getState();
  const base = add ? store.selected : [];
  const x0 = e.clientX;
  const y0 = e.clientY;
  let box: HTMLDivElement | null = null;
  startDrag(e, {
    move: (_dx, _dy, ev) => {
      if (!box) {
        box = document.createElement("div");
        box.className = "marquee";
        document.body.appendChild(box);
      }
      const l = Math.min(x0, ev.clientX);
      const t = Math.min(y0, ev.clientY);
      const r = Math.max(x0, ev.clientX);
      const b = Math.max(y0, ev.clientY);
      Object.assign(box.style, { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px` });
      const hit: number[] = [];
      document.querySelectorAll<HTMLElement>(".clip[data-clip]").forEach((el) => {
        const c = el.getBoundingClientRect();
        if (c.left < r && c.right > l && c.top < b && c.bottom > t) hit.push(Number(el.dataset.clip));
      });
      useSession.getState().setSelected([...new Set([...base, ...hit])]);
    },
    end: (moved) => {
      box?.remove();
      if (!moved) onClick();
    },
  });
}

/** The track a pointer is over, by the lane under it. */
function trackAt(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-track]");
  return el ? Number(el.dataset.track) : null;
}

interface ClipProps {
  clip: ClipState;
  track: TrackState;
  color: string;
  height: number;
  view: View;
  width: number;
  selected: boolean;
  /** Timeline frame for a pointer x. */
  toFrame: (clientX: number) => number;
}

function ClipView({ clip, track, color, height, view, width, selected, toFrame }: ClipProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const envEdit = useSession((s) => s.envEdit);
  const rate = useSession((s) => s.session?.rate ?? 48_000);
  const sourceFrames = useSession((s) => s.session?.sources.find((x) => x.id === clip.source)?.frames ?? clip.len);
  const sourceName = useSession((s) => s.session?.sources.find((x) => x.id === clip.source)?.name ?? "");

  const px = (f: number) => (f - view.start) / view.fpp;
  const x0 = px(clip.start);
  const x1 = px(clip.start + clip.len);
  // Keep the element a sane size when zoomed far in.
  const left = Math.max(x0, -EDGE - 2);
  const right = Math.min(x1, width + EDGE + 2);
  const w = Math.max(0, Math.round(right - left));
  const f0 = view.start + left * view.fpp;
  const waveH = Math.max(8, height - TITLE_H - 5);
  const peaks = usePeaks(clip.source, clip.offset + f0 - clip.start, clip.offset + f0 - clip.start + w * view.fpp, w);

  useEffect(() => {
    if (canvas.current && w > 0) drawClip(canvas.current, w, waveH, clip, f0, view.fpp, peaks, envEdit || clip.envelope.length > 0);
  }, [w, waveH, clip, f0, view.fpp, peaks, envEdit]);

  if (w <= 0) return null;
  const store = useSession.getState;

  /** y of the envelope at a pointer x, in px from the top of the wave area. */
  const envYAt = (clientX: number) => {
    const rel = clamp(toFrame(clientX) - clip.start, 0, clip.len - 1);
    return envY(envelopeAt(clip.envelope, clip.offset + rel), waveH);
  };

  /** Drag envelope point `i` of `pts` (already holding the new point, if
   * one was just added). */
  const dragPoint = (e: React.PointerEvent | PointerEvent, pts: EnvPoint[], i: number, added: boolean) => {
    const c0 = clip;
    const top = body.current!.getBoundingClientRect().top + TITLE_H;
    const lo = Math.max(c0.offset, i > 0 ? pts[i - 1].at + 1 : 0);
    const hi = Math.min(c0.offset + c0.len - 1, i < pts.length - 1 ? pts[i + 1].at - 1 : Infinity);
    const send = (p: EnvPoint) => {
      const next = pts.slice();
      next[i] = p;
      store().drag({ type: "set_envelope", clip: c0.id, points: next }, { kind: "clip", track: track.id, clip: { ...c0, envelope: next } });
    };
    if (added) send(pts[i]);
    startDrag(e, {
      move: (_dx, _dy, ev) => {
        const at = Math.round(clamp(toFrame(ev.clientX) - c0.start + c0.offset, lo, hi));
        let gain = clamp((1 - (ev.clientY - top - 1) / (waveH - 2)) * ENV_MAX, 0, ENV_MAX);
        if (!ev.altKey && Math.abs(gain - 1) < 0.04) gain = 1;
        send({ at, gain });
      },
      end: () => void store().commit(),
    });
  };

  const onBody = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const r = body.current!.getBoundingClientRect();
    const y = e.clientY - r.top - TITLE_H;
    // The envelope line: click adds a point and drags it.
    if (envEdit && !ctrl && y >= 0 && Math.abs(y - envYAt(e.clientX)) <= ENV_BAND) {
      const at = Math.round(clamp(toFrame(e.clientX) - clip.start, 0, clip.len - 1) + clip.offset);
      const g = envelopeAt(clip.envelope, at);
      let pts = clip.envelope.filter((p) => p.at !== at);
      if (!pts.length) {
        // A fresh envelope starts flat across the clip.
        const first = clip.offset;
        const last = clip.offset + clip.len - 1;
        pts = [{ at: first, gain: g }, { at: last, gain: g }].filter((p) => p.at !== at);
      }
      pts.push({ at, gain: g });
      pts.sort((a, b) => a.at - b.at);
      store().select(clip.id);
      dragPoint(e, pts, pts.findIndex((p) => p.at === at), true);
      return;
    }
    const c0 = clip;
    if (ctrl) {
      // Ctrl+drag draws a marquee that adds to the selection; Ctrl+click
      // toggles this clip.
      startMarquee(e, true, () => store().select(c0.id, true));
      return;
    }
    if (!selected) store().select(c0.id);
    // The selection moves together, the dragged clip leading.
    const st = store();
    const tracks = st.session!.tracks;
    const ids = st.selected.includes(c0.id) ? st.selected : [c0.id];
    const moving = tracks.flatMap((t, ti) => t.clips.filter((c) => ids.includes(c.id)).map((c) => ({ c, ti })));
    const myTi = tracks.findIndex((t) => t.id === track.id);
    const minStart = Math.min(...moving.map((m) => m.c.start));
    const minTi = Math.min(...moving.map((m) => m.ti));
    const maxTi = Math.max(...moving.map((m) => m.ti));
    const snaps = snapPoints(ids);
    let target = track.id;
    startDrag(e, {
      move: (dx, _dy, ev) => {
        let d = Math.round(dx * view.fpp);
        if (!ev.altKey) {
          // Snap the dragged clip's edges to other clips, 0 and the playhead.
          const tol = SNAP_PX * view.fpp;
          let best = tol;
          let snapped = d;
          const s0 = c0.start + d;
          for (const p of snaps) {
            for (const [dist, nd] of [
              [Math.abs(p - s0), p - c0.start],
              [Math.abs(p - (s0 + c0.len)), p - c0.len - c0.start],
            ]) {
              if (dist < best) {
                best = dist;
                snapped = nd;
              }
            }
          }
          d = snapped;
        }
        d = Math.max(d, -minStart);
        target = trackAt(ev.clientX, ev.clientY) ?? target;
        const dt = clamp(tracks.findIndex((t) => t.id === target) - myTi, -minTi, tracks.length - 1 - maxTi);
        const items = moving.map(({ c, ti }) => ({ track: tracks[ti + dt].id, clip: { ...c, start: c.start + d } }));
        store().drag(
          {
            type: "batch",
            commands: items.map((it) => ({ type: "move_clip" as const, clip: it.clip.id, track: it.track, start: it.clip.start })),
          },
          { kind: "clips", items },
        );
      },
      end: (moved) => {
        if (moved) void store().commit();
        else store().select(c0.id);
      },
    });
  };

  /** The cursor names what a press would do, as in the mockup. */
  const onHover = (e: React.PointerEvent) => {
    const el = body.current;
    if (!el || e.buttons || e.target !== el) return;
    const y = e.clientY - el.getBoundingClientRect().top - TITLE_H;
    const onLine = envEdit && y >= 0 && Math.abs(y - envYAt(e.clientX)) <= ENV_BAND;
    el.style.cursor = onLine ? "crosshair" : "";
  };

  const onEdge = (side: "l" | "r") => (e: React.PointerEvent) => {
    const c0 = clip;
    store().select(c0.id);
    startDrag(e, {
      move: (dx) => {
        const d = Math.round(dx * view.fpp);
        let next: ClipState;
        if (side === "l") {
          const first = Math.max(0, c0.start - c0.offset);
          const start = clamp(c0.start + d, first, c0.start + c0.len - MIN_LEN);
          const shift = start - c0.start;
          next = { ...c0, start, offset: c0.offset + shift, len: c0.len - shift };
        } else {
          next = { ...c0, len: clamp(c0.len + d, MIN_LEN, sourceFrames - c0.offset) };
        }
        store().drag(
          { type: "trim_clip", clip: c0.id, start: next.start, offset: next.offset, len: next.len },
          { kind: "clip", track: track.id, clip: next, ghost: true },
        );
      },
      end: () => void store().commit(),
    });
  };

  const fades = (fadeIn: number, fadeOut: number) =>
    ({ type: "set_clip_fades", clip: clip.id, fade_in: fadeIn, fade_out: fadeOut }) as const;
  const onFade = (side: "in" | "out") => (e: React.PointerEvent) => {
    const c0 = clip;
    startDrag(e, {
      move: (dx) => {
        const d = Math.round(dx * view.fpp);
        const fi = side === "in" ? clamp(c0.fadeIn + d, 0, c0.len - c0.fadeOut) : c0.fadeIn;
        const fo = side === "out" ? clamp(c0.fadeOut - d, 0, c0.len - c0.fadeIn) : c0.fadeOut;
        store().drag(fades(fi, fo), { kind: "clip", track: track.id, clip: { ...c0, fadeIn: fi, fadeOut: fo } });
      },
      end: () => void store().commit(),
    });
  };

  const fadeInX = clamp(px(clip.start + clip.fadeIn) - left, 0, w - 7);
  const fadeOutX = clamp(px(clip.start + clip.len - clip.fadeOut) - left - 7, 0, w - 7);
  const points = envEdit
    ? clip.envelope
        .map((p, i) => ({ p, i, x: px(clip.start + p.at - clip.offset) - left }))
        .filter(({ p }) => p.at >= clip.offset && p.at < clip.offset + clip.len)
    : [];

  return (
    <div
      ref={body}
      className={`clip${selected ? " sel" : ""}${track.muted ? " muted" : ""}`}
      style={{ left, width: w, ["--c" as string]: color, background: shade(color, 0.71) }}
      data-clip={clip.id}
      onPointerDown={onBody}
      onPointerMove={onHover}
      onContextMenu={(e) => {
        e.preventDefault();
        void store().deleteClips([clip.id]);
      }}
      data-hint="Drag to move (the selection moves together, onto other tracks too; snaps to clip edges, 0 and the playhead, Alt skips) · Ctrl+click adds to the selection · click the line to add an envelope point · right-click deletes · Ctrl+B duplicates"
    >
      <div className="ct">
        <span className="nm" style={{ paddingLeft: Math.max(0, -left) }}>
          {stem(sourceName)}
        </span>
        <GainReadout clip={clip} track={track.id} className="gain" />
      </div>
      <canvas ref={canvas} className="clipcv" />
      {x0 >= -EDGE && <div className="edge l" onPointerDown={onEdge("l")} data-hint="Drag to trim the start" />}
      {x1 <= width + EDGE && <div className="edge r" onPointerDown={onEdge("r")} data-hint="Drag to trim the end" />}
      <div
        className={`fh${clip.fadeIn > 0 ? " on" : ""}`}
        style={{ left: fadeInX }}
        onPointerDown={onFade("in")}
        onDoubleClick={() => void store().apply(fades(0, clip.fadeOut))}
        data-hint={`Fade in ${fmtMs(clip.fadeIn, rate)} · drag to change, double-click to remove`}
      />
      <div
        className={`fh${clip.fadeOut > 0 ? " on" : ""}`}
        style={{ left: fadeOutX }}
        onPointerDown={onFade("out")}
        onDoubleClick={() => void store().apply(fades(clip.fadeIn, 0))}
        data-hint={`Fade out ${fmtMs(clip.fadeOut, rate)} · drag to change, double-click to remove`}
      />
      {points.map(({ p, i, x }) => (
        <div
          key={i}
          className="ep"
          style={{ left: clamp(x, 3, w - 3), top: TITLE_H + envY(p.gain, waveH) }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            store().select(clip.id);
            dragPoint(e, clip.envelope, i, false);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void store().apply({ type: "set_envelope", clip: clip.id, points: clip.envelope.filter((_, k) => k !== i) });
          }}
          onDoubleClick={() =>
            void store().apply({
              type: "set_envelope",
              clip: clip.id,
              points: clip.envelope.map((q, k) => (k === i ? { ...q, gain: 1 } : q)),
            })
          }
          data-hint={`Envelope ${fmtDb(20 * Math.log10(Math.max(p.gain, 1e-6)))} · drag to move (Alt skips the 0 dB snap) · right-click deletes · double-click for 0 dB`}
        />
      ))}
      {w > 60 && height > 60 && <GainReadout clip={clip} track={track.id} className="gh" />}
    </div>
  );
}

/** Clip gain, FL style: drag up or down, double-click for 0 dB. */
export function GainReadout({ clip, track, className }: { clip: ClipState; track: number; className: string }) {
  const onDown = (e: React.PointerEvent) => {
    const g0 = clip.gainDb <= -96 ? -60 : clip.gainDb;
    const store = useSession.getState();
    startDrag(e, {
      move: (_dx, dy, ev) => {
        const step = ev.shiftKey ? 0.03 : 0.15;
        let db = Math.round(clamp(g0 - dy * step, -60, 24) * 10) / 10;
        if (!ev.altKey && Math.abs(db) < 0.45) db = 0;
        const gainDb = db <= -60 ? -96 : db;
        store.drag({ type: "set_clip_gain", clip: clip.id, gain_db: gainDb }, { kind: "clip", track, clip: { ...clip, gainDb } });
      },
      end: () => void store.commit(),
    });
  };
  return (
    <span
      className={className}
      onPointerDown={onDown}
      onDoubleClick={() => void useSession.getState().apply({ type: "set_clip_gain", clip: clip.id, gain_db: 0 })}
      data-hint="Clip gain · drag up or down (Shift for fine, Alt skips the 0 dB snap) · double-click for 0 dB"
    >
      {fmtDb(clip.gainDb, false)}
    </span>
  );
}

/** One track's lane: its clips, the range and the playhead. */
export function Lane({ track, index }: { track: TrackState; index: number }) {
  const view = useSession((s) => s.view);
  const width = useSession((s) => s.width);
  const playhead = useSession((s) => s.playhead);
  const range = useSession((s) => s.range);
  const playing = useSession((s) => s.playing);
  const selected = useSession((s) => s.selected);
  const draft = useSession((s) => s.draft);
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(96);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      useSession.getState().setWidth(el.clientWidth);
      setHeight(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toFrame = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, view.start + (clientX - r.left) * view.fpp);
  };

  // As in the mockup: dragging an empty lane selects the clips it touches;
  // a click only deselects. The playhead moves from the ruler alone.
  const onBackground = (e: React.PointerEvent) => {
    const add = e.ctrlKey || e.metaKey;
    startMarquee(e, add, () => {
      if (!add) useSession.getState().select(null);
    });
  };

  const px = (f: number) => (f - view.start) / view.fpp;
  const phX = px(playhead);
  const ghost = draft?.kind === "clip" && draft.ghost && draft.track === track.id ? draft.clip : null;
  const color = trackColor(index);

  return (
    <div
      className="lane"
      ref={ref}
      data-track={track.id}
      onPointerDown={onBackground}
      data-hint="Drag to select clips · click to deselect · drop files to add clips · the playhead moves from the ruler"
    >
      {ghost && <Ghost clip={ghost} view={view} width={width} height={height} />}
      {track.clips.map((c) => (
        <ClipView
          key={c.id}
          clip={c}
          track={track}
          color={color}
          height={height}
          view={view}
          width={width}
          selected={selected.includes(c.id)}
          toFrame={toFrame}
        />
      ))}
      {range && (
        <div className="rangeov" style={{ left: px(range.a), width: Math.max(1, (range.b - range.a) / view.fpp) }} />
      )}
      {(playing || phX > 0) && phX >= 0 && phX <= width && <div className="playhead" style={{ left: phX }} />}
    </div>
  );
}
