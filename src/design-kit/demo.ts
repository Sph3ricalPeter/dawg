/* The design kit's demo song: a session the app's real components render
 * from, outside Tauri. `installDemo` answers the app's IPC calls with it
 * (so stores, waveforms and the EQ analyser have data) and loads it into
 * the session store. Used only by the design kit build, never by the app. */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ClipState, DeviceState, Front, HistoryEntry, SessionState, SourceState, TrackState } from "@/lib/api";
import { useSession } from "@/stores/session-store";

export const RATE = 48_000;
export const BPM = 120;
/** One bar at 120 BPM, in frames. */
export const BAR = RATE * 2;

/** Each demo sample: its file name and the shape its waveform draws. */
export const SAMPLES = {
  kick: { id: 1, name: "Kick 01.wav" },
  snare: { id: 2, name: "Snare Tight.wav" },
  hats: { id: 3, name: "Hats Loop.wav" },
  bass: { id: 4, name: "Sub Bass.wav" },
  pad: { id: 5, name: "Pad Warm.wav" },
  vox: { id: 6, name: "Lead Vox.wav" },
  riser: { id: 7, name: "Riser Long.wav" },
} as const;
export type Sample = keyof typeof SAMPLES;

export const SOURCES: SourceState[] = Object.values(SAMPLES).map((s) => ({
  id: s.id,
  name: s.name,
  path: `C:\\Samples\\${s.name}`,
  frames: 8 * BAR,
  channels: 2,
  rate: RATE,
  missing: false,
}));

export const eqDevice = (id: number, on = true): DeviceState => ({
  id,
  on,
  kind: "eq",
  bands: [
    { kind: "low_cut", freq: 80, gainDb: 0, q: 0.7, slope: 24, on: true },
    { kind: "bell", freq: 320, gainDb: -3.5, q: 1.4, slope: 12, on: true },
    { kind: "bell", freq: 2400, gainDb: 2.5, q: 1, slope: 12, on: true },
    { kind: "high_shelf", freq: 9000, gainDb: 3, q: 0.7, slope: 12, on: true },
  ],
});
export const compDevice = (id: number, on = true): DeviceState => ({
  id,
  on,
  kind: "compressor",
  thresholdDb: -18,
  ratio: 4,
  attackMs: 10,
  releaseMs: 120,
  kneeDb: 6,
  makeupDb: 3,
  mix: 1,
  sidechain: null,
});
export const utilityDevice = (id: number, on = true): DeviceState => ({
  id,
  on,
  kind: "utility",
  gainDb: 0,
  width: 1.2,
  mono: false,
  flipL: false,
  flipR: false,
  dc: false,
});

let nextClip = 1;
export function demoClip(source: number, startBar: number, bars: number, extra: Partial<ClipState> = {}): ClipState {
  return {
    id: nextClip++,
    source,
    start: startBar * BAR,
    offset: 0,
    len: bars * BAR,
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    envelope: [],
    stretch: 1,
    pitch: 0,
    fadeInCurve: "linear",
    fadeOutCurve: "linear",
    reversed: false,
    ...extra,
  };
}

export function demoTrack(id: number, name: string, category: string | null, clips: ClipState[], o: Partial<TrackState> = {}): TrackState {
  return { id, color: null, category, name, gainDb: 0, pan: 0, muted: false, solo: false, clips, lane: true, chain: [], sends: [{ to: 0, gainDb: 0 }], ...o };
}

export const TRACKS: TrackState[] = [
  demoTrack(1, "Kick", "drums", [demoClip(1, 0, 8)], { gainDb: -2.5, chain: [eqDevice(11), compDevice(12)] }),
  demoTrack(2, "Snare", "drums", [demoClip(2, 1, 3), demoClip(2, 5, 3)], {
    gainDb: -4,
    pan: 0.1,
    sends: [
      { to: 0, gainDb: 0 },
      { to: 9, gainDb: -12 },
    ],
  }),
  demoTrack(3, "Hats", "perc", [demoClip(3, 0, 8, { gainDb: -3 })], { gainDb: -9, pan: -0.25 }),
  demoTrack(4, "Bass", "bass", [demoClip(4, 0, 4, { fadeOut: RATE / 2 }), demoClip(4, 4, 4)], { gainDb: -3, chain: [eqDevice(41), utilityDevice(42)] }),
  demoTrack(
    5,
    "Pads",
    "pads",
    [
      demoClip(5, 2, 6, {
        fadeIn: BAR,
        envelope: [
          { at: 0, gain: 0.6 },
          { at: 2 * BAR, gain: 1 },
          { at: 6 * BAR, gain: 0.8 },
        ],
      }),
    ],
    { gainDb: -8, pan: 0.2 },
  ),
  demoTrack(6, "Vox", "vox", [demoClip(6, 4, 4)], {
    gainDb: -1.5,
    chain: [eqDevice(61), compDevice(62), utilityDevice(63)],
    sends: [
      { to: 0, gainDb: 0 },
      { to: 9, gainDb: -8 },
    ],
  }),
  demoTrack(7, "Riser", "fx", [demoClip(7, 6, 2, { fadeIn: RATE })], { gainDb: -6, muted: true }),
  demoTrack(9, "Reverb", null, [], { lane: false, chain: [eqDevice(91)] }),
];

const ago = (label: string, kind: string, place: string[], change: string, s: number): HistoryEntry => ({
  label,
  at: Date.now() - s * 1000,
  kind,
  place,
  change,
  edits: 1,
  changes: 1,
});

export const STATE: SessionState = {
  scratch: false,
  path: null,
  project: "C:\\Projects\\Night Drive.dawg",
  name: "Night Drive",
  codec: "wav",
  format: { channels: 2, sampleRate: RATE, bits: 24, containerBytes: 3, float: false },
  kbps: null,
  frames: 8 * BAR,
  rate: RATE,
  tracks: TRACKS,
  masterDb: -1,
  masterChain: [compDevice(100)],
  bpm: BPM,
  sources: SOURCES,
  start: 0,
  end: 8 * BAR,
  simple: false,
  dirty: true,
  canUndo: true,
  canRedo: false,
  history: [
    ago("Add files", "import", ["Kick"], "7 files", 900),
    ago("Volume", "volume", ["Bass"], "0.0 → −3.0 dB", 600),
    ago("EQ band gain", "eq", ["Vox", "EQ", "Band 2 Bell"], "0.0 → −3.5 dB", 300),
    ago("AI: tighten drums", "ai", ["Kick", "Compressor"], "Ratio 2 → 4", 120),
    ago("Pan", "pan", ["Hats"], "C → 25L", 30),
  ],
  future: [],
  extraChunks: [],
  truncated: false,
};

const FRONT: Front = {
  tabs: [
    { id: 1, name: "Night Drive", scratch: false, dirty: true, path: STATE.project },
    { id: 2, name: "Vox take 3.wav", scratch: true, dirty: false, path: "C:\\Rec\\Vox take 3.wav" },
  ],
  active: 1,
  state: STATE,
  existing: false,
};

/** A believable waveform per demo sample, as the app's (lo, hi) peak pairs. */
function peaks(source: number, n: number): ArrayBuffer {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    let a: number;
    switch (source) {
      case 1:
        a = Math.exp(-((t * 16) % 1) * 7);
        break;
      case 2: {
        const p = (t * 8 + 0.5) % 1;
        a = p < 0.15 ? 0.8 * Math.exp(-p * 20) : 0.05;
        break;
      }
      case 3:
        a = 0.35 * Math.exp(-((t * 32) % 1) * 5);
        break;
      case 4:
        a = 0.7 * (0.6 + 0.4 * Math.sin(t * 60));
        break;
      case 5:
        a = 0.45 + 0.15 * Math.sin(t * 9);
        break;
      case 6:
        a = 0.25 + 0.45 * Math.abs(Math.sin(t * 23)) * Math.abs(Math.sin(t * 3.1));
        break;
      default:
        a = t * t * 0.9;
    }
    const j = 0.85 + 0.15 * Math.sin(i * 12.9898) * Math.sin(i * 4.1);
    out[2 * i] = -a * j;
    out[2 * i + 1] = a * j;
  }
  return out.buffer;
}

let installed = false;

/** Answers the app's IPC with the demo song and loads it, once. */
export function installDemo() {
  if (installed) return;
  installed = true;
  mockWindows("main");
  mockIPC((cmd, p) => {
    const a = (p ?? {}) as Record<string, number>;
    switch (cmd) {
      case "tabs":
      case "switch_tab":
        return FRONT;
      case "session_state":
      case "apply":
      case "end_gesture":
        return STATE;
      case "peaks":
        return peaks(a.source, a.buckets);
      case "spectrum":
        return { fromHz: 20, toHz: 20_000, db: Array.from({ length: 256 }, (_, i) => -30 - i * 0.12 + 8 * Math.sin(i / 9)) };
      case "app_info":
        return { version: "0.0.1", coreVersion: "0.0.1", channel: "release", updatesEnabled: false };
      case "recent_projects":
      case "recovery":
        return [];
      case "plugin:event|listen":
        return 1;
      default:
        return null;
    }
  });
  const s = useSession.getState();
  void s.syncTabs().then(() => useSession.getState().selectChannel(1, true));
}
