import type { ClipState, EnvPoint, FadeCurve, WavFormat } from "./api";

export const MIN_GAIN_DB = -96;
export const MAX_GAIN_DB = 24;

/** Same curve as `dawg_core::command::db_to_gain`. */
export function dbToGain(db: number): number {
  if (db <= MIN_GAIN_DB) return 0;
  if (db === 0) return 1;
  return Math.pow(10, db / 20);
}

/** Same as `Clip::fade_at` in dawg-core: frame `i` of the clip. */
export function fadeAt(
  clip: Pick<ClipState, "len" | "fadeIn" | "fadeOut"> & Partial<Pick<ClipState, "fadeInCurve" | "fadeOutCurve">>,
  i: number,
): number {
  let f = 1;
  if (i < clip.fadeIn) f *= fadeShape(clip.fadeInCurve ?? "linear", i / clip.fadeIn);
  if (clip.fadeOut > 0 && i >= clip.len - clip.fadeOut) {
    f *= fadeShape(clip.fadeOutCurve ?? "linear", Math.max(0, clip.len - (i + 1)) / clip.fadeOut);
  }
  return f;
}

/** Same as `FadeCurve::shape` in dawg-core: level at `t` along a fade. */
export function fadeShape(curve: FadeCurve, t: number): number {
  if (curve === "exp") return t * t;
  if (curve === "s") return t * t * (3 - 2 * t);
  return t;
}

/** Same as `Clip::source_at` in dawg-core: source frame of frame `i` of the
 * clip. */
export function srcAt(clip: Pick<ClipState, "offset" | "stretch">, i: number): number {
  return clip.stretch === 1 ? clip.offset + i : clip.offset + Math.floor(i / clip.stretch);
}

/** Same as `Clip::max_len`: the longest a clip can be from source frame
 * `offset` of a source `frames` long, in timeline frames. */
export function maxLen(clip: Pick<ClipState, "stretch">, offset: number, frames: number): number {
  const rest = Math.max(0, frames - offset);
  return clip.stretch === 1 ? rest : Math.floor(rest * clip.stretch);
}

/** "+3 st", "−0.25 st" */
export function fmtPitch(st: number, unit = true): string {
  const v = Math.round(st * 100) / 100;
  const body = Number.isInteger(v) ? Math.abs(v).toString() : Math.abs(v).toFixed(2);
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${body}${unit ? " st" : "st"}`;
}

/** "×1.50" */
export function fmtStretch(s: number): string {
  return `×${s.toFixed(2)}`;
}

/** Same as `Clip::envelope_at` in dawg-core: gain at source frame `at`. */
export function envelopeAt(env: EnvPoint[], at: number): number {
  if (!env.length) return 1;
  if (at <= env[0].at) return env[0].gain;
  const last = env[env.length - 1];
  if (at >= last.at) return last.gain;
  let k = 1;
  while (env[k].at <= at) k++;
  const a = env[k - 1];
  const b = env[k];
  return a.gain + ((b.gain - a.gain) * (at - a.at)) / (b.at - a.at);
}

/** "0:01.250" */
export function fmtTime(seconds: number, digits = 3): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const [whole, frac] = rest.toFixed(digits).split(".");
  return `${m}:${whole.padStart(2, "0")}${digits > 0 ? "." + frac : ""}`;
}

/** "2.840 s" */
export function fmtSeconds(seconds: number): string {
  return `${seconds.toFixed(3)} s`;
}

/** "+4.2 dB", "0.0 dB", "-inf dB" */
export function fmtDb(db: number | null, unit = true): string {
  const u = unit ? " dB" : "dB";
  if (db === null || db <= MIN_GAIN_DB || !Number.isFinite(db)) return `−∞${u}`;
  const v = Math.abs(db) < 0.05 ? 0 : db;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}${u}`;
}

export function fmtMs(frames: number, rate: number): string {
  return `${Math.round((frames / rate) * 1000)} ms`;
}

/** "44.1 kHz · 24-bit · stereo", or "44.1 kHz · MP3 192 kbps · stereo" */
export function fmtFormat(f: WavFormat, kbps?: number | null): string {
  const khz = f.sampleRate / 1000;
  const rate = `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
  const depth =
    kbps != null ? `MP3 ${kbps} kbps` : f.float ? `${f.bits}-bit float` : `${f.bits}-bit`;
  const ch =
    f.channels === 1 ? "mono" : f.channels === 2 ? "stereo" : `${f.channels} channels`;
  return `${rate} · ${depth} · ${ch}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Folder part of a Windows or POSIX path, with its trailing separator. */
export function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(0, i + 1) : "";
}

/** "kick_03.wav" → "kick_03" */
export function stem(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}
