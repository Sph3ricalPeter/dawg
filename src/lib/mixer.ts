/**
 * Channels, chains and routing as the UI needs them: channel numbers, what
 * feeds what (so a send or sidechain that would loop is greyed out before
 * the engine refuses it), device names and defaults. Mirrors
 * `dawg_core::model::Project::feeds` and `dawg_core::device`.
 */

import { MASTER, type DeviceKind, type DeviceParams, type DeviceState, type SessionState, type TrackState } from "./api";
import { VOL_MAX, VOL_MIN } from "@/components/Volume";

export const DEVICE_KINDS: DeviceKind[] = ["eq", "compressor", "utility"];

export const DEVICE_NAMES: Record<DeviceKind, string> = {
  eq: "EQ",
  compressor: "Compressor",
  utility: "Utility",
};

export const DEVICE_HINTS: Record<DeviceKind, string> = {
  eq: "Shape the tone: up to 12 bells, shelves and cuts",
  compressor: "Even out the level; can duck to another channel (sidechain)",
  utility: "Gain, stereo width, mono, phase flip and a DC filter",
};

/** Most devices a chain holds, as `dawg_core::device::MAX_DEVICES`. */
export const MAX_DEVICES = 16;

/** Loudest a send goes, as `dawg_core::command::MAX_SEND_DB`. */
export const SEND_MAX_DB = 6;

/** Each device's name in a chain: "EQ", then "EQ 2" for a second one. */
export function deviceNames(chain: DeviceState[]): string[] {
  return chain.map((d, i) => {
    const n = chain.slice(0, i).filter((x) => x.kind === d.kind).length;
    return n ? `${DEVICE_NAMES[d.kind]} ${n + 1}` : DEVICE_NAMES[d.kind];
  });
}

/** Default settings for a new device, as `DeviceParams::default_for`. */
export function defaultParams(kind: DeviceKind): DeviceParams {
  switch (kind) {
    case "eq":
      return { kind, bands: [] };
    case "compressor":
      return { kind, thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 100, kneeDb: 6, makeupDb: 0, mix: 1 };
    case "utility":
      return { kind, gainDb: 0, width: 1, mono: false, flipL: false, flipR: false, dc: false };
  }
}

/** A device's settings without its id, power and sidechain. */
export function paramsOf<D extends DeviceState>(d: D): Omit<D, "id" | "on" | "sidechain"> {
  const p: Partial<D> = { ...d };
  delete p.id;
  delete p.on;
  delete p.sidechain;
  return p as Omit<D, "id" | "on" | "sidechain">;
}

/** The master's colour in chips and strips. */
export const MASTER_COLOR = "#d6d6d6";

/** "C3 Snare" */
export function chanLabel(s: SessionState, id: number): string {
  return `C${channelNumber(s, id)} ${channelName(s, id)}`;
}

/** The channels as the mixer orders them: the master, then every track. */
export function mixerOrder(tracks: TrackState[]): number[] {
  return [MASTER, ...tracks.map((t) => t.id)];
}

/** "C", "L40", "R25" */
export function fmtPan(p: number): string {
  const v = Math.round(p * 100);
  return v === 0 ? "C" : v < 0 ? `L${-v}` : `R${v}`;
}

/** Whether the device changes the sound, as `Device::active`. */
export function deviceActive(d: DeviceState): boolean {
  if (!d.on) return false;
  switch (d.kind) {
    case "eq":
      return d.bands.some((b) => b.on);
    case "compressor":
      return d.mix > 0;
    case "utility":
      return d.gainDb !== 0 || d.width !== 1 || d.mono || d.flipL || d.flipR || d.dc;
  }
}

/** A channel's chain; `MASTER` is the master's. */
export function chainOf(s: SessionState, channel: number, tracks: TrackState[] = s.tracks): DeviceState[] {
  if (channel === MASTER) return s.masterChain;
  return tracks.find((t) => t.id === channel)?.chain ?? [];
}

/** The channel a device is on (`MASTER` for the master), or null. */
export function deviceChannel(s: SessionState, device: number): number | null {
  if (s.masterChain.some((d) => d.id === device)) return MASTER;
  return s.tracks.find((t) => t.chain.some((d) => d.id === device))?.id ?? null;
}

/** C0 for the master, then C1, C2… in strip order. */
export function channelNumber(s: SessionState, id: number): number {
  return id === MASTER ? 0 : s.tracks.findIndex((t) => t.id === id) + 1;
}

export function channelName(s: SessionState, id: number): string {
  if (id === MASTER) return "Master";
  const i = s.tracks.findIndex((t) => t.id === id);
  return i < 0 ? "?" : s.tracks[i].name || `Track ${i + 1}`;
}

/** The channels channel `id` takes signal from: senders, and its devices'
 * sidechain sources. */
function inputs(s: SessionState, id: number): number[] {
  const v = s.tracks.filter((t) => t.sends.some((x) => x.to === id)).map((t) => t.id);
  for (const d of chainOf(s, id)) if (d.sidechain != null) v.push(d.sidechain);
  return v;
}

/** Whether `from`'s signal reaches `to` through sends and sidechains. */
export function feeds(s: SessionState, from: number, to: number): boolean {
  const seen = new Set([to]);
  const stack = [to];
  while (stack.length) {
    for (const i of inputs(s, stack.pop()!)) {
      if (i === from) return true;
      if (!seen.has(i)) {
        seen.add(i);
        stack.push(i);
      }
    }
  }
  return false;
}

/** Whether connecting `from` into `to` (a send, or a sidechain on one of
 * `to`'s devices) would make a loop. */
export function wouldLoop(s: SessionState, from: number, to: number): boolean {
  return from === to || from === MASTER || feeds(s, to, from);
}

/** Where a send level sits on its knob: the volume knob's law, −∞ at the
 * bottom, 0 dB at 75%, +6 dB at the top. */
export function sendFrac(db: number): number {
  if (db <= VOL_MIN) return 0;
  return db >= 0 ? 0.75 + (0.25 * db) / VOL_MAX : 0.75 * Math.pow(10, db / 40);
}
