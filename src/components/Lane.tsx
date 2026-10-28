import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ClipState, type SessionState } from "@/lib/api";
import { startDrag } from "@/lib/drag";
import { clamp, dbToGain, fadeAt, fmtDb, fmtMs, stem } from "@/lib/format";
import { MIN_LEN, useClip, useSession, type View } from "@/stores/session-store";

const TITLE_H = 14;
/** Grab width of the trim zones at each clip edge. */
const EDGE = 6;
const CLIP_COLOR = "#ee9f98";

interface Peaks {
  view: View;
  width: number;
  key: string;
  data: Float32Array;
}

/** Peaks for what's on screen, refetched when the view or the file changes. */
function usePeaks(session: SessionState | null, view: View, width: number): Peaks | null {
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const fileRev = useSession((s) => s.fileRev);
  const key = session ? `${session.path}:${fileRev}` : "";
  useEffect(() => {
    if (!key) return;
    let live = true;
    const to = view.start + width * view.fpp;
    const raf = requestAnimationFrame(() => {
      void api.peaks(view.start, to, Math.ceil(width)).then((data) => {
        if (live) setPeaks({ view, width, key, data });
      });
    });
    return () => {
      live = false;
      cancelAnimationFrame(raf);
    };
  }, [key, view, width]);
  return peaks && peaks.key === key ? peaks : null;
}

function draw(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  view: View,
  clip: ClipState,
  frames: number,
  peaks: Peaks | null,
) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const x = canvas.getContext("2d");
  if (!x) return;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, width, height);

  const px = (f: number) => (f - view.start) / view.fpp;
  const cx0 = px(clip.start);
  const cx1 = px(clip.start + clip.len);
  const top = 2;
  const bottom = height - 3;
  const waveTop = top + TITLE_H;
  const mid = (waveTop + bottom) / 2;
  const half = (bottom - waveTop) / 2 - 2;
  const fileEnd = px(frames);

  // The clip body.
  x.fillStyle = "#a9706b";
  x.fillRect(cx0, top, cx1 - cx0, bottom - top);

  if (!peaks) return;
  // Peaks were fetched for a slightly older view while scrolling: map by frame.
  const pv = peaks.view;
  const gain = dbToGain(clip.gainDb);
  const cut = "rgba(255,255,255,.13)";
  const ghost = "rgba(16,16,16,.2)";
  const ink = "rgba(16,16,16,.8)";
  const over: number[] = [];

  // Zoomed out, draw a smoothed amplitude outline like the mockup; zoomed in,
  // the real min/max so single cycles show.
  const outline = view.fpp > 24;
  const lo = new Float32Array(width);
  const hi = new Float32Array(width);
  const state = new Int8Array(width); // 0 none, 1 cut away, 2 in clip
  const gains = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    const f0 = view.start + i * view.fpp;
    const f1 = f0 + view.fpp;
    if (f0 >= frames) break;
    const b = Math.floor((f0 - pv.start) / pv.fpp);
    if (b < 0 || b >= peaks.width) continue;
    lo[i] = peaks.data[2 * b];
    hi[i] = peaks.data[2 * b + 1];
    if (outline) {
      const a = Math.max(Math.abs(lo[i]), Math.abs(hi[i]));
      lo[i] = -a;
      hi[i] = a;
    }
    const inClip = f1 > clip.start && f0 < clip.start + clip.len;
    state[i] = inClip ? 2 : 1;
    if (inClip) {
      const rel = clamp((f0 + f1) / 2 - clip.start, 0, clip.len - 1);
      gains[i] = gain * fadeAt(clip, rel);
    }
  }
  if (outline) {
    // Light smoothing over ±2 px, as the mockup draws it.
    const a = Float32Array.from(hi);
    for (let i = 0; i < width; i++) {
      let m = 0;
      let k = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(width - 1, i + 2); j++) {
        if (state[j] === state[i]) {
          m += a[j];
          k++;
        }
      }
      hi[i] = k ? m / k : a[i];
      lo[i] = -hi[i];
    }
  }

  const bar = (i: number, l: number, h: number) =>
    x.fillRect(i, mid - h * half, 1, Math.max(1, (h - l) * half));
  for (let i = 0; i < width; i++) {
    if (state[i] === 0) continue;
    if (state[i] === 1) {
      // Audio the trim cuts away, so you can see what you're losing.
      x.fillStyle = cut;
      bar(i, lo[i], hi[i]);
      continue;
    }
    x.fillStyle = ghost;
    bar(i, lo[i], hi[i]);
    const g = gains[i];
    const plo = lo[i] * g;
    const phi = hi[i] * g;
    x.fillStyle = ink;
    bar(i, Math.max(-1, plo), Math.min(1, phi));
    if (phi > 1 || plo < -1) over.push(i);
  }

  // Anything over full scale.
  x.fillStyle = "#ff4d4d";
  for (const i of over) {
    x.fillRect(i, waveTop + 1, 1, 2);
    x.fillRect(i, bottom - 3, 1, 2);
  }

  // Fades: shade outside the diagonal.
  x.fillStyle = "rgba(0,0,0,.28)";
  x.strokeStyle = "rgba(0,0,0,.4)";
  x.lineWidth = 1;
  if (clip.fadeIn > 0) {
    const fx = px(clip.start + clip.fadeIn);
    x.beginPath();
    x.moveTo(cx0, waveTop);
    x.lineTo(fx, waveTop);
    x.lineTo(cx0, bottom);
    x.closePath();
    x.fill();
    x.beginPath();
    x.moveTo(cx0, bottom);
    x.lineTo(fx, waveTop);
    x.stroke();
  }
  if (clip.fadeOut > 0) {
    const fx = px(clip.start + clip.len - clip.fadeOut);
    x.beginPath();
    x.moveTo(cx1, waveTop);
    x.lineTo(fx, waveTop);
    x.lineTo(cx1, bottom);
    x.closePath();
    x.fill();
    x.beginPath();
    x.moveTo(cx1, bottom);
    x.lineTo(fx, waveTop);
    x.stroke();
  }

  // End of the file.
  if (fileEnd < width) {
    x.fillStyle = "rgba(255,255,255,.06)";
    x.fillRect(fileEnd, 0, 1, height);
  }
}

/** The one track of a scratch session: the clip and everything on it. */
export function Lane() {
  const session = useSession((s) => s.session);
  const clip = useClip();
  const view = useSession((s) => s.view);
  const width = useSession((s) => s.width);
  const playhead = useSession((s) => s.playhead);
  const range = useSession((s) => s.range);
  const playing = useSession((s) => s.playing);
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [height, setHeight] = useState(300);
  const peaks = usePeaks(session, view, width);

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

  useEffect(() => {
    if (canvas.current && clip && session) {
      draw(canvas.current, width, height, view, clip, session.frames, peaks);
    }
  }, [width, height, view, clip, session, peaks]);

  useWheel(ref);

  if (!session || !clip) return <div className="lane" ref={ref} />;

  const rate = session.format.sampleRate;
  const px = (f: number) => (f - view.start) / view.fpp;
  const toFrame = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return clamp(view.start + (clientX - r.left) * view.fpp, 0, session.frames);
  };
  const x0 = px(clip.start);
  const x1 = px(clip.start + clip.len);
  // Keep the clip element a sane size when zoomed far in.
  const left = Math.max(x0, -EDGE - 2);
  const right = Math.min(x1, width + EDGE + 2);
  const w = right - left;

  const onBackground = (e: React.PointerEvent) => {
    const a = toFrame(e.clientX);
    const store = useSession.getState();
    startDrag(e, {
      move: (_dx, _dy, ev) => {
        const b = toFrame(ev.clientX);
        store.setRange({ a: Math.min(a, b), b: Math.max(a, b) });
      },
      end: (moved) => {
        if (!moved) {
          store.setRange(null);
          store.setPlayhead(a);
        }
      },
    });
  };

  const onEdge = (side: "l" | "r") => (e: React.PointerEvent) => {
    const c0 = clip;
    const store = useSession.getState();
    startDrag(e, {
      move: (dx) => {
        const d = Math.round(dx * view.fpp);
        if (side === "l") {
          const start = clamp(c0.start + d, c0.start - c0.offset, c0.start + c0.len - MIN_LEN);
          const shift = start - c0.start;
          store.drag({ ...c0, start, offset: c0.offset + shift, len: c0.len - shift });
        } else {
          const len = clamp(c0.len + d, MIN_LEN, session.frames - c0.offset);
          store.drag({ ...c0, len });
        }
      },
      end: () => void store.commit(),
    });
  };

  const onFade = (side: "in" | "out") => (e: React.PointerEvent) => {
    const c0 = clip;
    const store = useSession.getState();
    startDrag(e, {
      move: (dx) => {
        const d = Math.round(dx * view.fpp);
        if (side === "in") {
          store.drag({ ...c0, fadeIn: clamp(c0.fadeIn + d, 0, c0.len - c0.fadeOut) });
        } else {
          store.drag({ ...c0, fadeOut: clamp(c0.fadeOut - d, 0, c0.len - c0.fadeIn) });
        }
      },
      end: () => void store.commit(),
    });
  };

  const fadeInX = clamp(px(clip.start + clip.fadeIn) - left, 0, w - EDGE);
  const fadeOutX = clamp(px(clip.start + clip.len - clip.fadeOut) - left - EDGE, 0, w - EDGE);
  const phX = px(playhead);

  return (
    <div className="lane" ref={ref} onPointerDown={onBackground} data-hint="Click to place the playhead · drag to pick a range, then Ctrl+T crops to it">
      <canvas ref={canvas} className="lanecv" />
      {w > 0 && (
        <div
          className="clip sel"
          style={{ left, width: w, ["--c" as string]: CLIP_COLOR }}
        >
          <div className="ct" data-hint="Drag across the clip to pick a range · drag its edges to trim">
            <span className="nm" style={{ paddingLeft: Math.max(0, -left) }}>
              {stem(session.name)}
            </span>
            <GainReadout clip={clip} className="gain" />
          </div>
          {x0 >= -EDGE && (
            <div className="edge l" onPointerDown={onEdge("l")} data-hint="Drag to trim the start" />
          )}
          {x1 <= width + EDGE && (
            <div className="edge r" onPointerDown={onEdge("r")} data-hint="Drag to trim the end" />
          )}
          <div
            className={`fh${clip.fadeIn > 0 ? " on" : ""}`}
            style={{ left: fadeInX }}
            onPointerDown={onFade("in")}
            onDoubleClick={() =>
              void useSession.getState().apply({ type: "set_clip_fades", track: 0, clip: 0, fade_in: 0, fade_out: clip.fadeOut })
            }
            title={`Fade in ${fmtMs(clip.fadeIn, rate)}`}
            data-hint={`Fade in ${fmtMs(clip.fadeIn, rate)} · drag to change, double-click to remove`}
          />
          <div
            className={`fh${clip.fadeOut > 0 ? " on" : ""}`}
            style={{ left: fadeOutX }}
            onPointerDown={onFade("out")}
            onDoubleClick={() =>
              void useSession.getState().apply({ type: "set_clip_fades", track: 0, clip: 0, fade_in: clip.fadeIn, fade_out: 0 })
            }
            title={`Fade out ${fmtMs(clip.fadeOut, rate)}`}
            data-hint={`Fade out ${fmtMs(clip.fadeOut, rate)} · drag to change, double-click to remove`}
          />
          {w > 60 && <GainReadout clip={clip} className="gh" />}
        </div>
      )}
      {range && (
        <div
          className="rangeov"
          style={{ left: px(range.a), width: Math.max(1, (range.b - range.a) / view.fpp) }}
        />
      )}
      {(playing || phX > 0) && phX >= 0 && phX <= width && <div className="playhead" style={{ left: phX }} />}
    </div>
  );
}

/** Clip gain, FL style: drag up or down, double-click for 0 dB. */
export function GainReadout({ clip, className }: { clip: ClipState; className: string }) {
  const onDown = (e: React.PointerEvent) => {
    const g0 = clip.gainDb <= -96 ? -60 : clip.gainDb;
    const store = useSession.getState();
    startDrag(e, {
      move: (_dx, dy, ev) => {
        const step = ev.shiftKey ? 0.03 : 0.15;
        let db = Math.round(clamp(g0 - dy * step, -60, 24) * 10) / 10;
        if (!ev.altKey && Math.abs(db) < 0.45) db = 0;
        store.drag({ ...clip, gainDb: db <= -60 ? -96 : db });
      },
      end: () => void store.commit(),
    });
  };
  return (
    <span
      className={className}
      onPointerDown={onDown}
      onDoubleClick={() =>
        void useSession.getState().apply({ type: "set_clip_gain", track: 0, clip: 0, gain_db: 0 })
      }
      data-hint="Clip gain · drag up or down (Shift for fine, Alt skips the 0 dB snap) · double-click for 0 dB"
    >
      {fmtDb(clip.gainDb, false)}
    </span>
  );
}

/** Ctrl+wheel zooms around the mouse; the wheel scrolls through time. */
function useWheel(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = useSession.getState();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey) {
        s.zoomAt(e.clientX - r.left, Math.exp(e.deltaY * 0.0025));
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        s.scrollTo(s.view.start + d * s.view.fpp);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}
