import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { api, apiMessage, type ClipState, type Command, type EnvPoint, type FadeCurve } from "@/lib/api";
import { clamp, fmtDb, fmtMs, fmtSeconds, fmtTime, MAX_GAIN_DB, MIN_GAIN_DB, srcAt } from "@/lib/format";
import { dragKnob } from "@/lib/knob";
import { ENV_MAX, trackColor } from "@/lib/timeline";
import { allClips, useSession } from "@/stores/session-store";
import { Knob } from "./Knob";

/** Envelope shapes from the mockup: `t` is 0..1 along the clip and `v` the
 * height, where 0.8 is 0 dB (as on the clip). */
const PRESETS: { key: string; label: string; hint: string; points: { t: number; v: number }[] }[] = [
  { key: "flat", label: "Flat", hint: "No envelope: the clip at its own gain", points: [] },
  { key: "fadein", label: "Fade in", hint: "Rises from silence over the first half", points: [{ t: 0, v: 0 }, { t: 0.55, v: 0.8 }, { t: 1, v: 0.8 }] },
  { key: "fadeout", label: "Fade out", hint: "Falls to silence over the second half", points: [{ t: 0, v: 0.8 }, { t: 0.45, v: 0.8 }, { t: 1, v: 0 }] },
  { key: "swell", label: "Swell", hint: "Builds slowly to just over 0 dB", points: [{ t: 0, v: 0.06 }, { t: 0.88, v: 0.95 }, { t: 1, v: 0.95 }] },
  { key: "duck", label: "Duck", hint: "Dips once, early in the clip, and comes back", points: [{ t: 0, v: 0.8 }, { t: 0.4, v: 0.8 }, { t: 0.46, v: 0.28 }, { t: 0.7, v: 0.8 }, { t: 1, v: 0.8 }] },
  { key: "swellcut", label: "Swell + cut", hint: "Builds to the end, then cuts off", points: [{ t: 0, v: 0.05 }, { t: 0.93, v: 0.95 }, { t: 1, v: 0 }] },
];

const CURVES: { curve: FadeCurve; label: string; hint: string }[] = [
  { curve: "linear", label: "Linear", hint: "Straight fades" },
  { curve: "exp", label: "Exp", hint: "Slow from silence, quick near full level: sounds even to the ear" },
  { curve: "s", label: "S", hint: "Eases in and out of the fade" },
];

/** A preset as envelope points on `clip`'s own source frames. */
function presetPoints(clip: ClipState, key: string): EnvPoint[] {
  const p = PRESETS.find((x) => x.key === key);
  if (!p) return [];
  return p.points.map(({ t, v }) => ({
    at: srcAt(clip, clamp(Math.round(t * clip.len), 0, clip.len - 1)),
    gain: clamp(v / 0.8, 0, ENV_MAX),
  }));
}

function PresetShape({ points }: { points: { t: number; v: number }[] }) {
  const pts = points.length ? points : [{ t: 0, v: 0.8 }, { t: 1, v: 0.8 }];
  return (
    <svg viewBox="0 0 44 12">
      <polyline points={pts.map((p) => `${(p.t * 44).toFixed(1)},${((1 - p.v) * 10 + 1).toFixed(1)}`).join(" ")} />
    </svg>
  );
}

/** Fade length knob: 0 to the whole clip, on a square-law travel so short
 * fades are easy to set. */
function fadeFrac(frames: number, len: number): number {
  return len > 0 ? Math.sqrt(clamp(frames / len, 0, 1)) : 0;
}

const GAIN_KNOB_MIN = -36;

function KnobCell({
  label,
  value,
  f,
  hint,
  onDrag,
  onReset,
}: {
  label: string;
  value: string;
  f: number;
  hint: string;
  onDrag: (e: React.PointerEvent) => void;
  onReset: () => void;
}) {
  return (
    <div className="kc" data-hint={hint} onPointerDown={onDrag} onDoubleClick={onReset}>
      <span className="kl">{label}</span>
      <Knob f={f} size={28} />
      <span className="kv">{value}</span>
    </div>
  );
}

/** The clip settings popover from the mockup: what the clip is, its level
 * and fades, envelope presets and the clip's actions. With several clips
 * selected, the presets, Reverse and Reset apply to all of them. */
export function ClipPanel() {
  const at = useSession((s) => s.clipPanel);
  const session = useSession((s) => s.session);
  const selected = useSession((s) => s.selected);
  const draft = useSession((s) => s.draft);
  const range = useSession((s) => s.range);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = () => useSession.getState().closeClipPanel();

  useEffect(() => {
    if (!at) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [at]);

  // Keep it on screen.
  useLayoutEffect(() => {
    if (!at || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: clamp(at.x, 8, window.innerWidth - r.width - 8),
      top: clamp(at.y, 8, window.innerHeight - r.height - 8),
    });
  }, [at, selected.length]);

  if (!at || !session) return null;
  const all = allClips(session);
  const ids = selected.includes(at.clip) ? selected : [at.clip];
  const items = all
    .filter((c) => ids.includes(c.clip.id))
    .map((c) => (draft?.kind === "clip" && draft.clip.id === c.clip.id ? { ...c, clip: draft.clip } : c));
  if (!items.length) return null;
  const store = useSession.getState;
  const rate = session.rate;
  const batch = (commands: Command[], label?: string) =>
    void store().apply(commands.length === 1 && !label ? commands[0] : { type: "batch", commands, label });
  const clips = items.map((c) => c.clip);

  const presets = (
    <div className="isec">
      <h4>Envelope preset{clips.length > 1 ? " (all)" : ""}</h4>
      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className="pre"
            data-hint={p.hint}
            onClick={() =>
              batch(
                clips.map((c) => ({ type: "set_envelope", clip: c.id, points: presetPoints(c, p.key) })),
                `Envelope: ${p.label}`,
              )
            }
          >
            <PresetShape points={p.points} />
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
  const allReversed = clips.every((c) => c.reversed);
  const reverse = (
    <button
      className={`chk${allReversed ? " on" : ""}`}
      onClick={() => batch(clips.map((c) => ({ type: "reverse_clip", clip: c.id, reversed: !allReversed })))}
      data-hint="Play the audio backwards; the envelope turns around with it"
    >
      <i />
      Reverse
    </button>
  );
  const reset = () =>
    batch(
      clips.flatMap((c): Command[] => [
        { type: "set_clip_gain", clip: c.id, gain_db: 0 },
        { type: "set_clip_fades", clip: c.id, fade_in: 0, fade_out: 0, curve_in: "linear", curve_out: "linear" },
        { type: "set_envelope", clip: c.id, points: [] },
      ]),
      clips.length > 1 ? `Reset ${clips.length} clips` : "Reset clip",
    );
  const act = (label: string, keys: string, run: () => void, disabled = false) => (
    <button
      className="menu-item"
      disabled={disabled}
      onClick={() => {
        close();
        run();
      }}
    >
      {label}
      {keys && <kbd>{keys}</kbd>}
    </button>
  );
  const style = pos ?? { left: at.x, top: at.y, visibility: "hidden" as const };

  if (items.length > 1) {
    const names = [...new Set(items.map((c) => c.track.name || "Track"))];
    return (
      <div className="clippanel" ref={ref} style={style} role="dialog" aria-label="Clip settings">
        <div className="isec">
          <h4>Selection</h4>
          <div className="idn">{items.length} clips</div>
          <div className="dim">{names.join(", ")}</div>
          <div className="irow">{reverse}</div>
        </div>
        {presets}
        <div className="isec acts">
          {act("Duplicate", "Ctrl+B", () => void store().duplicateSelected())}
          {act("Reset gain, fades and envelope", "", reset)}
          {act("Delete", "Del", () => void store().deleteClips(ids))}
        </div>
      </div>
    );
  }

  const { clip } = items[0];
  const track = items[0].track.id;
  const tIndex = session.tracks.findIndex((t) => t.id === track);
  const src = session.sources.find((s) => s.id === clip.source);
  const drag = (c: ClipState, cmd: Command) => store().drag(cmd, { kind: "clip", track, clip: c });
  const done = () => void store().commit();
  const fades = (fadeIn: number, fadeOut: number, curve?: FadeCurve): Command => ({
    type: "set_clip_fades",
    clip: clip.id,
    fade_in: Math.round(fadeIn),
    fade_out: Math.round(fadeOut),
    ...(curve ? { curve_in: curve, curve_out: curve } : {}),
  });
  const gainKnob = (e: React.PointerEvent) =>
    dragKnob(
      e,
      Math.max(clip.gainDb, GAIN_KNOB_MIN),
      { rate: 0.15, min: GAIN_KNOB_MIN, max: MAX_GAIN_DB, step: 1, res: 0.1, detent: 0.3 },
      (v, end) => {
        if (end) return done();
        const db = v <= GAIN_KNOB_MIN ? MIN_GAIN_DB : v;
        drag({ ...clip, gainDb: db }, { type: "set_clip_gain", clip: clip.id, gain_db: db });
      },
    );
  // Fade knobs work on the square root of the length, 0 to 1000.
  const fadeKnob = (which: "in" | "out") => (e: React.PointerEvent) => {
    const now = which === "in" ? clip.fadeIn : clip.fadeOut;
    const other = which === "in" ? clip.fadeOut : clip.fadeIn;
    dragKnob(e, fadeFrac(now, clip.len) * 1000, { rate: 4, min: 0, max: 1000, step: 50, res: 1, detent: 0 }, (v, end) => {
      if (end) return done();
      const frames = Math.min(clip.len - other, Math.round((v / 1000) ** 2 * clip.len));
      const next = which === "in" ? { ...clip, fadeIn: frames } : { ...clip, fadeOut: frames };
      drag(next, fades(next.fadeIn, next.fadeOut));
    });
  };
  const curve = clip.fadeInCurve === clip.fadeOutCurve ? clip.fadeInCurve : null;
  const env = clip.envelope;
  const envDb = (g: number) => fmtDb(g > 0 ? 20 * Math.log10(g) : null);
  const path = src?.path ?? "";

  return (
    <div className="clippanel" ref={ref} style={style} role="dialog" aria-label="Clip settings">
      <div className="isec">
        <h4>Clip</h4>
        <div className="idn" style={{ ["--c" as string]: trackColor(Math.max(0, tIndex)) }}>
          <span className="sw" />
          <span className="n">{src?.name ?? "Clip"}</span>
        </div>
        {path && (
          <div className="faint mono path" title={path}>
            {path}
          </div>
        )}
        {src && (
          <div className="dim">
            {src.rate / 1000} kHz · {src.channels === 1 ? "mono" : src.channels === 2 ? "stereo" : `${src.channels} channels`} ·{" "}
            {fmtSeconds(src.frames / rate)}
            {src.missing && <span className="warn-note"> · missing</span>}
          </div>
        )}
        <div className="dim mono small">
          {fmtTime(clip.start / rate)} · {fmtSeconds(clip.len / rate)}
        </div>
        <div className="irow">{reverse}</div>
      </div>
      <div className="isec">
        <h4>Level</h4>
        <div className="krow">
          <KnobCell
            label="Gain"
            value={fmtDb(clip.gainDb)}
            f={clamp((Math.max(clip.gainDb, GAIN_KNOB_MIN) - GAIN_KNOB_MIN) / (MAX_GAIN_DB - GAIN_KNOB_MIN), 0, 1)}
            hint="Clip gain · drag up/down (Shift fine, Ctrl 1 dB steps) · double-click resets to 0 dB"
            onDrag={gainKnob}
            onReset={() => batch([{ type: "set_clip_gain", clip: clip.id, gain_db: 0 }])}
          />
          <KnobCell
            label="Fade in"
            value={fmtMs(clip.fadeIn, rate)}
            f={fadeFrac(clip.fadeIn, clip.len)}
            hint="Fade in length · drag up/down (Shift fine) · double-click removes it"
            onDrag={fadeKnob("in")}
            onReset={() => batch([fades(0, clip.fadeOut)])}
          />
          <KnobCell
            label="Fade out"
            value={fmtMs(clip.fadeOut, rate)}
            f={fadeFrac(clip.fadeOut, clip.len)}
            hint="Fade out length · drag up/down (Shift fine) · double-click removes it"
            onDrag={fadeKnob("out")}
            onReset={() => batch([fades(clip.fadeIn, 0)])}
          />
        </div>
        <div className="irow">
          <span className="k">Fade curve</span>
          <span className="seg">
            {CURVES.map((c) => (
              <button
                key={c.curve}
                className={curve === c.curve ? "on" : ""}
                data-hint={c.hint}
                onClick={() => batch([fades(clip.fadeIn, clip.fadeOut, c.curve)], `Fade curve: ${c.label}`)}
              >
                {c.label}
              </button>
            ))}
          </span>
        </div>
        <div className="irow">
          <span className="k">Envelope</span>
          <span className="dim">
            {env.length
              ? `${env.length} point${env.length === 1 ? "" : "s"}, ${envDb(Math.min(...env.map((p) => p.gain)))} to ${envDb(Math.max(...env.map((p) => p.gain)))}`
              : "flat"}
          </span>
        </div>
      </div>
      {presets}
      <div className="isec acts">
        {act("Duplicate", "Ctrl+B", () => void store().duplicateSelected())}
        {act("Split at playhead", "Ctrl+E", () => void store().splitAtPlayhead())}
        {act("Crop to range", "Ctrl+T", () => void store().cropToRange(), !range)}
        <div className="menu-sep" />
        {act("Reset gain, fades and envelope", "", reset)}
        {isTauri() &&
          path &&
          act("Show in Explorer", "", () => {
            api.revealPath(path).catch((e) => store().showToast(apiMessage(e), { error: true }));
          })}
        {act("Delete", "Del", () => void store().deleteClips([clip.id]))}
      </div>
    </div>
  );
}
