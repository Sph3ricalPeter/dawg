import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { api, type BandKind, type EqBand, type Spectrum, type TrackState } from "@/lib/api";
import { startDrag } from "@/lib/drag";
import {
  bandResponse,
  clampBand,
  fmtHz,
  fmtHzShort,
  hasGain,
  isCut,
  KIND_NAMES,
  MAX_BANDS,
  MAX_FREQ,
  MAX_GAIN_DB,
  MAX_Q,
  MIN_FREQ,
  MIN_Q,
  SLOPES,
} from "@/lib/eq";
import { clamp, fmtDb } from "@/lib/format";
import { dragKnob } from "@/lib/knob";
import { trackColor } from "@/lib/timeline";
import { useSession, useTracks } from "@/stores/session-store";
import { Knob } from "./Knob";

const GRID_HZ = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
/** Display ranges in dB, as in Pro-Q: the curve's scale, not a limit. */
const RANGES = [12, 30];

/** The graph's scales: frequency ↔ x across `w` px, log from 10 Hz to
 * `top`; dB ↔ y over `h` px, ±`range` dB. */
function geometry(w: number, h: number, top: number, range: number) {
  const l0 = Math.log(MIN_FREQ);
  const l1 = Math.log(top);
  return {
    x: (hz: number) => ((Math.log(hz) - l0) / (l1 - l0)) * w,
    hz: (x: number) => Math.exp(l0 + (x / w) * (l1 - l0)),
    y: (db: number) => h / 2 - (db / range) * (h / 2 - 8),
    dbAt: (py: number) => ((h / 2 - py) / (h / 2 - 8)) * range,
  };
}

/** The analyser's scale: 0 dBFS at the top, this many dB below at the
 * bottom. */
const SPECTRUM_FLOOR = 96;
/** Analyser tilt in dB per octave around 1 kHz, as in Pro-Q, so pink noise
 * reads flat. */
const TILT = 4.5;
/** How fast the analyser falls, in dB per poll (about 30 ms). */
const SPECTRUM_FALL = 1.5;

/** Polls the tapped track's spectrum while the EQ is open, with Pro-Q style
 * hold-and-fall smoothing. */
function useSpectrum(track: number | null): Spectrum | null {
  const [spec, setSpec] = useState<Spectrum | null>(null);
  useEffect(() => {
    if (track === null || !isTauri()) return;
    let live = true;
    let busy = false;
    let last = 0;
    let shown: Spectrum | null = null;
    let raf = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (busy || t - last < 30) return;
      last = t;
      busy = true;
      void api
        .spectrum(track)
        .then((s) => {
          if (!live) return;
          if (s) {
            const prev: Spectrum | null = shown;
            shown = { ...s, db: prev && prev.db.length === s.db.length ? s.db.map((d, i) => Math.max(d, prev.db[i] - SPECTRUM_FALL)) : s.db };
          } else if (shown) {
            const db = shown.db.map((d) => d - SPECTRUM_FALL);
            shown = db.every((d) => d < -SPECTRUM_FLOOR - 24) ? null : { ...shown, db };
          }
          setSpec(shown);
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    raf = requestAnimationFrame(tick);
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      setSpec(null);
      void api.spectrum(null).catch(() => undefined);
    };
  }, [track]);
  return spec;
}

/** A new band where the user double-clicked: cuts at the far ends, a bell
 * anywhere else. */
function newBand(hz: number, db: number): EqBand {
  const kind: BandKind = hz < 40 ? "low_cut" : hz > 14_000 ? "high_cut" : "bell";
  return clampBand({ kind, freq: hz, gainDb: hasGain(kind) ? db : 0, q: kind === "bell" ? 1 : Math.SQRT1_2, slope: 24, on: true });
}

/** The track EQ, docked under the playlist: a Pro-Q style curve with a node
 * per band, and the selected band's controls. */
export function EqPanel() {
  const trackId = useSession((s) => s.eqTrack);
  const rate = useSession((s) => s.session?.rate ?? 48_000);
  const tracks = useTracks();
  const index = tracks.findIndex((t) => t.id === trackId);
  const track = index >= 0 ? tracks[index] : null;
  const hasTrack = track !== null;
  const [sel, setSel] = useState(0);
  const [range, setRange] = useState(RANGES[0]);
  const graph = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 160 });
  const wheelTimer = useRef<number | undefined>(undefined);
  const spec = useSpectrum(track ? track.id : null);

  useLayoutEffect(() => {
    const el = graph.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasTrack]);

  const color = trackColor(Math.max(0, index));
  const top = Math.min(MAX_FREQ, rate / 2);
  const ax = geometry(size.w, size.h, top, range);
  const { y, dbAt } = ax;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !track) return;
    const ax = geometry(size.w, size.h, top, range);
    const { y } = ax;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const x = c.getContext("2d");
    if (!x) return;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    // Grid.
    x.font = "9.5px Cascadia Mono, Consolas, monospace";
    x.textBaseline = "top";
    for (const hz of GRID_HZ) {
      if (hz > top) continue;
      const gx = Math.round(ax.x(hz)) + 0.5;
      x.fillStyle = "#1f1f1f";
      x.fillRect(gx, 0, 1, h);
      x.fillStyle = "#5a5a5a";
      x.fillText(fmtHzShort(hz), gx + 3, h - 12);
    }
    const step = range <= 12 ? 6 : 10;
    for (let db = -range; db <= range; db += step) {
      const gy = Math.round(y(db)) + 0.5;
      x.fillStyle = db === 0 ? "#2e2e2e" : "#1a1a1a";
      x.fillRect(0, gy, w, 1);
      if (db !== -range && db !== range) {
        x.fillStyle = "#5a5a5a";
        x.fillText(`${db > 0 ? "+" : ""}${db}`, w - 22, gy + 2);
      }
    }
    // What the track sounds like after the EQ.
    if (spec) {
      const n = spec.db.length;
      const ratio = spec.toHz / spec.fromHz;
      x.beginPath();
      x.moveTo(0, h);
      for (let i = 0; i < n; i++) {
        const hz = spec.fromHz * Math.pow(ratio, i / (n - 1));
        if (hz > top) break;
        const db = spec.db[i] + TILT * Math.log2(hz / 1000);
        x.lineTo(ax.x(hz), clamp((-db / SPECTRUM_FLOOR) * h, 0, h));
      }
      x.lineTo(w, h);
      x.closePath();
      x.fillStyle = "rgba(255,255,255,.07)";
      x.fill();
      x.strokeStyle = "rgba(255,255,255,.16)";
      x.lineWidth = 1;
      x.stroke();
    }
    // Each band faintly, then the sum.
    const live = track.eqBypass ? [] : track.eq.filter((b) => b.on);
    const fns = live.map((b) => bandResponse(b, rate));
    const pts: number[] = [];
    for (let px = 0; px <= w; px += 2) {
      const hz = ax.hz(px);
      pts.push(fns.reduce((sum, f) => sum + f(hz), 0));
    }
    fns.forEach((f, i) => {
      const selected = track.eq.indexOf(live[i]) === sel;
      x.beginPath();
      for (let px = 0; px <= w; px += 2) {
        const py = y(clamp(f(ax.hz(px)), -range * 1.2, range * 1.2));
        if (px === 0) x.moveTo(px, py);
        else x.lineTo(px, py);
      }
      x.lineTo(w, y(0));
      x.lineTo(0, y(0));
      x.closePath();
      x.fillStyle = selected ? "rgba(255,255,255,.10)" : "rgba(255,255,255,.04)";
      x.fill();
    });
    x.beginPath();
    pts.forEach((db, i) => {
      const py = y(clamp(db, -range * 1.2, range * 1.2));
      if (i === 0) x.moveTo(0, py);
      else x.lineTo(i * 2, py);
    });
    x.strokeStyle = track.eqBypass ? "#6b6b6b" : color;
    x.lineWidth = 2;
    x.stroke();
  }, [track, size, range, rate, sel, color, top, spec]);

  if (!track) return null;
  const store = useSession.getState;
  const bands = track.eq;
  const band = bands[sel] ?? null;

  const send = (next: EqBand[], live: boolean, t: TrackState = track) => {
    const cmd = { type: "set_track_eq" as const, track: t.id, bands: next };
    if (live) store().drag(cmd, { kind: "track", track: { ...t, eq: next } });
    else void store().apply(cmd);
  };
  const setBand = (i: number, b: EqBand, live: boolean) => send(bands.map((x, k) => (k === i ? clampBand(b) : x)), live);

  // Wheel changes Q, as in Pro-Q; the steps settle into one undo step.
  const onWheelBand = (i: number, e: React.WheelEvent) => {
    e.stopPropagation();
    const b = bands[i];
    setSel(i);
    setBand(i, { ...b, q: b.q * Math.exp(-e.deltaY * (e.shiftKey ? 0.0003 : 0.0015)) }, true);
    window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => void store().commit(), 350);
  };

  const dragNode = (e: React.PointerEvent, i: number, bs: EqBand[]) => {
    const b0 = bs[i];
    const r = graph.current!.getBoundingClientRect();
    const x0 = ax.x(b0.freq);
    const g0 = b0.gainDb;
    const dbPerPx = range / (size.h / 2 - 8);
    startDrag(e, {
      slop: 1,
      move: (dx, dy, ev) => {
        // Shift moves a tenth as far.
        const k = ev.shiftKey ? 0.1 : 1;
        const hz = ax.hz(clamp(x0 + dx * k, 0, r.width));
        let g = hasGain(b0.kind) ? clamp(Math.round((g0 - dy * k * dbPerPx) * 10) / 10, -MAX_GAIN_DB, MAX_GAIN_DB) : 0;
        if (!ev.altKey && Math.abs(g) < 0.3) g = 0;
        const next = bs.map((x, j) => (j === i ? clampBand({ ...b0, freq: Math.round(hz * 10) / 10, gainDb: g }) : x));
        send(next, true);
      },
      end: (moved) => {
        if (moved) void store().commit();
      },
    });
  };

  const onGraphDouble = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".eqn")) return;
    if (bands.length >= MAX_BANDS) {
      store().showToast(`An EQ holds ${MAX_BANDS} bands`);
      return;
    }
    const r = graph.current!.getBoundingClientRect();
    const b = newBand(ax.hz(e.clientX - r.left), Math.round(dbAt(e.clientY - r.top) * 10) / 10);
    send([...bands, b], false);
    setSel(bands.length);
  };

  const remove = (i: number) => {
    send(
      bands.filter((_, k) => k !== i),
      false,
    );
    setSel((s) => (s >= i ? Math.max(0, s - 1) : s));
  };

  const knob = (
    label: string,
    value: string,
    f: number,
    bipolar: boolean,
    onDown: (e: React.PointerEvent) => void,
    onReset: (() => void) | null,
    hint: string,
  ) => (
    <div className="eqk" onPointerDown={onDown} onDoubleClick={onReset ?? undefined} data-hint={hint}>
      <Knob f={f} bipolar={bipolar} size={26} />
      <div>
        <div className="eql">{label}</div>
        <div className="eqv mono">{value}</div>
      </div>
    </div>
  );

  const lf = (hz: number) => (Math.log(hz) - Math.log(MIN_FREQ)) / (Math.log(MAX_FREQ) - Math.log(MIN_FREQ));
  const lq = (q: number) => (Math.log(q) - Math.log(MIN_Q)) / (Math.log(MAX_Q) - Math.log(MIN_Q));

  return (
    <section className="eqp" style={{ ["--c" as string]: color }}>
      <header className="eqh">
        <b>EQ</b>
        <span className="eqt">{track.name || `Track ${index + 1}`}</span>
        <button
          className={`eqb${track.eqBypass ? "" : " on"}`}
          onClick={() => void store().apply({ type: "set_track_eq", track: track.id, bands, bypass: !track.eqBypass })}
          data-hint="Turns the whole EQ on or off, keeping its bands"
        >
          {track.eqBypass ? "Off" : "On"}
        </button>
        <span className="sp" />
        <span className="dim">
          {bands.length ? `${bands.length} band${bands.length === 1 ? "" : "s"}` : "Double-click the curve to add a band"}
        </span>
        <button
          className="eqb"
          onClick={() => setRange(RANGES[(RANGES.indexOf(range) + 1) % RANGES.length])}
          data-hint="Display range of the curve"
        >
          ±{range} dB
        </button>
        <button className="eqx" onClick={() => store().openEq(null)} data-hint="Close the EQ">
          ✕
        </button>
      </header>
      <div className="eqbody">
        <div
          className="eqg"
          ref={graph}
          onDoubleClick={onGraphDouble}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget || e.target === canvas.current) setSel(-1);
          }}
          data-hint="Double-click to add a band (a cut at either end, a bell between) · drag a band to move it · wheel over a band for its width"
        >
          <canvas ref={canvas} />
          {bands.map((b, i) => {
            const nx = ax.x(Math.min(b.freq, top));
            const ny = hasGain(b.kind) ? y(clamp(b.gainDb, -range, range)) : y(clamp(bandResponse(b, rate)(b.freq), -range, range));
            return (
              <div
                key={i}
                className={`eqn${i === sel ? " sel" : ""}${b.on && !track.eqBypass ? "" : " off"}`}
                style={{ left: nx, top: ny }}
                onPointerDown={(e) => {
                  setSel(i);
                  dragNode(e, i, bands);
                }}
                onWheel={(e) => onWheelBand(i, e)}
                onDoubleClick={() => hasGain(b.kind) && setBand(i, { ...b, gainDb: 0 }, false)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  remove(i);
                }}
                data-hint={`${KIND_NAMES[b.kind]} ${fmtHz(b.freq)}${hasGain(b.kind) ? ` ${fmtDb(b.gainDb)}` : ""} · drag to move (Shift fine, Alt skips the 0 dB snap) · wheel for width · double-click for 0 dB · right-click deletes`}
              >
                {i + 1}
              </div>
            );
          })}
        </div>
        <div className="eqs">
          {band ? (
            <>
              <div className="eqrow">
                <span className="eqnum">{sel + 1}</span>
                <select
                  value={band.kind}
                  onChange={(e) => setBand(sel, { ...band, kind: e.target.value as BandKind }, false)}
                  data-hint="Band shape"
                >
                  {(Object.keys(KIND_NAMES) as BandKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_NAMES[k]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="eqrow knobs">
                {knob(
                  "Freq",
                  fmtHz(band.freq),
                  lf(band.freq),
                  false,
                  (e) =>
                    dragKnob(
                      e,
                      Math.log2(band.freq),
                      { rate: 0.02, min: Math.log2(MIN_FREQ), max: Math.log2(MAX_FREQ), step: 1 / 3, res: 0.001, detent: 0 },
                      (v, done) => (done ? void store().commit() : setBand(sel, { ...band, freq: Math.round(2 ** v * 10) / 10 }, true)),
                    ),
                  null,
                  "Frequency · drag up or down (Shift fine, Ctrl in third-octaves)",
                )}
                {hasGain(band.kind) &&
                  knob(
                    "Gain",
                    fmtDb(band.gainDb),
                    band.gainDb / MAX_GAIN_DB,
                    true,
                    (e) =>
                      dragKnob(
                        e,
                        band.gainDb,
                        { rate: 0.1, min: -MAX_GAIN_DB, max: MAX_GAIN_DB, step: 1, res: 0.1, detent: 0.3 },
                        (v, done) => (done ? void store().commit() : setBand(sel, { ...band, gainDb: v }, true)),
                      ),
                    () => setBand(sel, { ...band, gainDb: 0 }, false),
                    "Gain · drag up or down (Shift fine, Ctrl 1 dB steps) · double-click for 0 dB",
                  )}
                {knob(
                  isCut(band.kind) ? "Reso" : "Q",
                  band.q.toFixed(2),
                  lq(band.q),
                  false,
                  (e) =>
                    dragKnob(
                      e,
                      Math.log2(band.q),
                      { rate: 0.015, min: Math.log2(MIN_Q), max: Math.log2(MAX_Q), step: 0.5, res: 0.001, detent: 0 },
                      (v, done) => (done ? void store().commit() : setBand(sel, { ...band, q: Math.round(2 ** v * 1000) / 1000 }, true)),
                    ),
                  () => setBand(sel, { ...band, q: isCut(band.kind) || band.kind.endsWith("shelf") ? Math.SQRT1_2 : 1 }, false),
                  isCut(band.kind)
                    ? "Resonance at the corner · 0.71 is flat · double-click resets"
                    : "Width: higher is narrower · double-click resets",
                )}
                {isCut(band.kind) && (
                  <div className="eqslope" data-hint="Slope of the cut in dB per octave">
                    {SLOPES.map((s) => (
                      <button key={s} className={s === band.slope ? "on" : ""} onClick={() => setBand(sel, { ...band, slope: s }, false)}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="eqrow">
                <button
                  className={`eqb${band.on ? " on" : ""}`}
                  onClick={() => setBand(sel, { ...band, on: !band.on }, false)}
                  data-hint="Turns this band on or off"
                >
                  {band.on ? "On" : "Off"}
                </button>
                <button className="eqb" onClick={() => remove(sel)} data-hint="Deletes this band (or right-click it)">
                  Delete
                </button>
              </div>
            </>
          ) : (
            <p className="dim eqhelp">
              Double-click the curve to add a band. Drag a band to move it, use the wheel over it for its width, and right-click
              to delete it.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
