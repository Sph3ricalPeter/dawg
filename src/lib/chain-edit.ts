/**
 * Edits to channels, chains and sends from the Chain and Mixer panels. A
 * drag (`live`) shows its result straight away as a draft and plays it,
 * and the release (`commit`) makes it one undo step; anything else is one
 * command. The engine checks every edit too: a send or sidechain that would
 * loop is refused with a message, shown as a toast.
 */

import { MASTER, type Command, type DeviceParams, type DeviceState, type SendState, type TrackState } from "./api";
import { deviceChannel } from "./mixer";
import { useSession, type Draft } from "@/stores/session-store";

const store = useSession.getState;

/** A channel as it's shown right now, with any drag applied. */
function shownTrack(id: number): TrackState | null {
  const st = store();
  const d = st.draft;
  if (d?.kind === "track" && d.track.id === id) return d.track;
  return st.session?.tracks.find((t) => t.id === id) ?? null;
}

function shownMasterChain(): DeviceState[] {
  const st = store();
  return st.draft?.kind === "masterChain" ? st.draft.chain : (st.session?.masterChain ?? []);
}

/** A draft of `channel` with its chain changed by `f`. */
function chainDraft(channel: number, f: (chain: DeviceState[]) => DeviceState[]): Draft | null {
  if (channel === MASTER) return { kind: "masterChain", chain: f(shownMasterChain()) };
  const t = shownTrack(channel);
  return t ? { kind: "track", track: { ...t, chain: f(t.chain) } } : null;
}

function send(cmd: Command, draft: Draft | null, live: boolean) {
  if (live && draft) store().drag(cmd, draft);
  else void store().apply(cmd);
}

/** Ends a drag: its last value becomes one undo step. */
export function commitDrag() {
  void store().commit();
}

/** New settings for a device; `live` while a knob or curve is dragged. */
export function setDeviceParams(device: DeviceState, params: DeviceParams, live: boolean) {
  const s = store().session;
  if (!s) return;
  const ch = deviceChannel(s, device.id);
  const cmd: Command = { type: "set_device", device: device.id, params };
  const draft = ch === null ? null : chainDraft(ch, (c) => c.map((d) => (d.id === device.id ? ({ ...d, ...params } as DeviceState) : d)));
  send(cmd, draft, live);
}

export function setDeviceOn(device: number, on: boolean) {
  void store().apply({ type: "set_device", device, on });
}

/** Turns every device on a channel off, or back on if they all are off. */
export function bypassAll(chain: DeviceState[]) {
  const on = chain.every((d) => !d.on);
  const commands: Command[] = chain.filter((d) => d.on !== on).map((d) => ({ type: "set_device", device: d.id, on }));
  if (commands.length) void store().apply({ type: "batch", commands, label: on ? "Enable all devices" : "Bypass all devices" });
}

/** A channel's volume and pan from the mixer, as from the track header. */
export function setMix(track: TrackState, m: { gain_db?: number; pan?: number }, live: boolean) {
  const cmd: Command = { type: "set_track_mix", track: track.id, ...m };
  const t = shownTrack(track.id) ?? track;
  send(cmd, { kind: "track", track: { ...t, gainDb: m.gain_db ?? t.gainDb, pan: m.pan ?? t.pan } }, live);
}

export function setMasterGain(gain_db: number, live: boolean) {
  send({ type: "set_master_gain", gain_db }, { kind: "master", db: gain_db }, live);
}

/** Sets (or adds) the send from `from` to `to`. */
export function setSend(from: number, to: number, gain_db: number, live: boolean) {
  const t = shownTrack(from);
  if (!t) return;
  const sends: SendState[] = t.sends.some((x) => x.to === to)
    ? t.sends.map((x) => (x.to === to ? { to, gainDb: gain_db } : x))
    : [...t.sends, { to, gainDb: gain_db }];
  send({ type: "set_send", from, to, gain_db }, { kind: "track", track: { ...t, sends } }, live);
}

export function removeSend(from: number, to: number) {
  void store().apply({ type: "remove_send", from, to });
}
