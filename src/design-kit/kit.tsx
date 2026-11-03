/* The design kit: the app's own components, each with plain props, for the
 * Claude Design system and canvas. Every one renders the real component
 * from src/ui or src/components; an adapter here only turns plain props
 * (strings from the canvas, numbers, flags) into what that component
 * takes. Change how something looks in the app's code, then rebuild the
 * kit (`npm run design:build`), never here. */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DeviceKind, DeviceState, TrackState } from "@/lib/api";
import { MASTER } from "@/lib/api";
import type { KnobControl } from "@/lib/knob";
import { defaultParams, deviceNames, MASTER_COLOR } from "@/lib/mixer";
import { trackColor } from "@/lib/timeline";
import { useSession } from "@/stores/session-store";
import { App, EmptyState as AppEmptyState, StatusBar as AppStatusBar } from "@/App";
import { Browser } from "@/components/Browser";
import { ChainPanel as AppChainPanel, DeviceCard as AppDeviceCard } from "@/components/ChainPanel";
import { Editor, TimelineHead, TrackHeader as AppTrackHeader } from "@/components/Editor";
import { ExportDialog as AppExportDialog } from "@/components/ExportDialog";
import { HistoryPanel as AppHistoryPanel } from "@/components/HistoryPanel";
import { ClipView } from "@/components/Lane";
import { MixerPanel as AppMixerPanel, Strip } from "@/components/MixerPanel";
import { TitleBar as AppTitleBar } from "@/components/TitleBar";
import { DawgMark } from "@/components/DawgMark";
import { Knob as UiKnob, KnobField as UiKnobField, type Concern } from "@/ui/Knob";
import { LevelMeter as UiLevelMeter } from "@/ui/Meter";
import { HEADER_LAW, MASTER_LAW, MIXER_LAW } from "@/ui/meter-law";
import { Menu as UiMenu, MenuItem as UiMenuItem } from "@/ui/Menu";
import { KNOB } from "@/ui/tokens";
import { Volume as UiVolume } from "@/ui/Volume";
import { demoClip, eqDevice, compDevice, utilityDevice, SAMPLES, SOURCES, type Sample } from "./demo";

export { Button, ToolButton, CloseButton, PowerButton } from "@/ui/Button";
export { Icon } from "@/ui/Icon";
export { MenuLabel, MenuSep, MenuNote } from "@/ui/Menu";
export { Dialog } from "@/ui/Dialog";
export { DawgMark };

/* Props from the canvas come as strings ("-3", "true"); these read them. */
type Num = number | string | undefined;
type Flag = boolean | string | undefined;
const num = (v: Num, d: number) => (v === undefined || v === "" ? d : Number(v));
const flag = (v: Flag) => v === true || v === "true" || v === "";
const noop = () => undefined;
const still: KnobControl = { ref: noop, onPointerDown: noop } as unknown as KnobControl;

/** Renders its children once the demo song is in the session store. */
function WithSession({ children }: { children: ReactNode }) {
  const ready = useSession((s) => !!s.session);
  return ready ? <>{children}</> : null;
}

/** Sets or clears a class on the first element inside, for a state the
 * real component reads from the store (the selected track or strip). */
function useClassOn(cls: string, on: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  // Re-run once the session (and with it the component) is in.
  useSession((s) => !!s.session);
  useLayoutEffect(() => {
    ref.current?.firstElementChild?.classList.toggle(cls, on);
  });
  return ref;
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

const SIZES: Record<string, number> = KNOB;

/** The arc knob. `size`: badge, sm, md, side or lg (or px). */
export function Knob({ value = 0.5, bipolar, size = "md", concern = "vol" }: { value?: Num; bipolar?: Flag; size?: string | number; concern?: Concern }) {
  return <UiKnob f={num(value, 0.5)} bipolar={flag(bipolar)} size={SIZES[size] ?? num(size, KNOB.md)} color={`var(--k-${concern})`} />;
}

/** A knob with its value and name. */
export function KnobField({
  label = "Ratio",
  value = "4.0:1",
  f = 0.5,
  bipolar,
  concern = "vol",
  layout = "stack",
  size = "lg",
}: {
  label?: string;
  value?: string;
  f?: Num;
  bipolar?: Flag;
  concern?: Concern;
  layout?: "stack" | "side";
  size?: string | number;
}) {
  return (
    <UiKnobField
      label={label}
      value={value}
      f={num(f, 0.5)}
      bipolar={flag(bipolar)}
      concern={concern}
      layout={layout}
      size={SIZES[size] ?? num(size, KNOB.lg)}
      control={still}
      hint={label}
    />
  );
}

/** The one volume control: knob, value, and a meter after it. */
export function Volume({ db = 0, meter, level = -12 }: { db?: Num; meter?: "track" | "master" | "none"; level?: Num }) {
  const m = meter === "track" ? <LevelMeter level={level} kind="track" /> : meter === "master" ? <LevelMeter level={level} kind="master" /> : null;
  const vol = <UiVolume db={num(db, 0)} hint="Volume" onDrag={noop} onSet={noop} before={meter === "track" ? m : undefined} after={meter === "master" ? m : undefined} />;
  // The master's meter is styled inside the title bar's master group.
  return meter === "master" ? <div className="master kit-inline">{vol}</div> : vol;
}

/** A stereo level meter held at `level` dB (left) and `right` dB.
 * `kind`: track (vertical, in a track header), master (horizontal). */
export function LevelMeter({ level = -12, right, kind = "track" }: { level?: Num; right?: Num; kind?: "track" | "master" }) {
  const l = 10 ** (num(level, -12) / 20);
  const r = 10 ** (num(right ?? level, -12) / 20);
  const track = kind === "track";
  const meter = <UiLevelMeter className={track ? "tm" : "mstr"} vertical={track} law={track ? HEADER_LAW : MASTER_LAW} live read={() => [l, r]} />;
  // Each meter is styled where the app places it: in a volume, or in the
  // title bar's master group.
  return <span className={`${track ? "vol" : "master"} kit-inline`}>{meter}</span>;
}
void MIXER_LAW;

/** The menu box, drawn where it's placed (in the app it drops under its
 * button or sits at the pointer). */
export function Menu({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <UiMenu title={title} className="kit-static">
      {children}
    </UiMenu>
  );
}

/** A menu row. */
export function MenuItem({ label = "Rename…", keys, disabled, checked }: { label?: string; keys?: string; disabled?: Flag; checked?: Flag | "none" }) {
  return (
    <UiMenuItem label={label} keys={keys} disabled={flag(disabled)} checked={checked === undefined || checked === "none" ? undefined : flag(checked)} run={noop} />
  );
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

/** The title bar: menu, tabs, transport, master volume, history, export
 * and the window buttons. */
export function TitleBar() {
  return <AppTitleBar info={{ version: "0.0.1", coreVersion: "0.0.1", channel: "release", updatesEnabled: false }} />;
}

/** The status bar: the hint for what's under the pointer, the agent chip
 * and the mixdown format. */
export function StatusBar({ hint = "" }: { hint?: string }) {
  return (
    <WithSession>
      <AppStatusBar hint={hint} />
    </WithSession>
  );
}

/** What the timeline shows with no tracks. */
export function EmptyState({ dropping }: { dropping?: Flag }) {
  return (
    <main className="arrangement kit-panel">
      <AppEmptyState dropping={flag(dropping)} />
    </main>
  );
}

/** The whole window, as the app draws it, from the demo song. */
export function AppWindow() {
  return <App />;
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

function track(p: { name?: string; category?: string; color?: Num; gainDb?: Num; pan?: Num; muted?: Flag; solo?: Flag }, id: number): TrackState {
  return {
    id,
    color: p.color === undefined || p.color === "" ? null : num(p.color, 0),
    category: p.category || null,
    name: p.name ?? "Track",
    gainDb: num(p.gainDb, 0),
    pan: num(p.pan, 0),
    muted: flag(p.muted),
    solo: flag(p.solo),
    clips: [],
    lane: true,
    chain: [],
    sends: [{ to: MASTER, gainDb: 0 }],
  };
}

let ids = 1000;
const useId = () => useState(() => ids++)[0];

/** A track's header: number (on/off), solo, volume with its meter, pan.
 * `category` colours it (drums, perc, bass, leads, pads, vox, fx, foley,
 * ambience, music, ui) unless `color` picks a palette index. */
export function TrackHeader({
  number = 1,
  height = 76,
  selected,
  level,
  ...p
}: {
  name?: string;
  number?: Num;
  category?: string;
  color?: Num;
  gainDb?: Num;
  pan?: Num;
  muted?: Flag;
  solo?: Flag;
  selected?: Flag;
  height?: Num;
  level?: Num;
}) {
  const id = useId();
  const ref = useClassOn("sel", flag(selected));
  const t = track(p, id);
  const index = num(number, 1) - 1;
  useEffect(() => {
    if (level === undefined) return;
    const levels = [...useSession.getState().levels];
    const v = 10 ** (num(level, -12) / 20);
    levels[index] = [v, v];
    useSession.setState({ levels, playing: true });
  }, [level, index]);
  return (
    <WithSession>
      <div ref={ref} className="kit-th" style={{ height: num(height, 76) }}>
        <AppTrackHeader track={t} index={index} onResize={noop} />
      </div>
    </WithSession>
  );
}

/** A clip on its lane: name bar, waveform and gain badge. `sample` picks
 * the demo audio (kick, snare, hats, bass, pad, vox, riser); `fadeIn` and
 * `fadeOut` are shares of its length; `envelope` draws a volume line. */
export function Clip({
  sample = "kick",
  category,
  color,
  number = 1,
  width = 320,
  height = 76,
  gainDb,
  fadeIn,
  fadeOut,
  envelope,
  selected,
}: {
  sample?: Sample;
  category?: string;
  color?: Num;
  number?: Num;
  width?: Num;
  height?: Num;
  gainDb?: Num;
  fadeIn?: Num;
  fadeOut?: Num;
  envelope?: Flag;
  selected?: Flag;
}) {
  const w = num(width, 320);
  const h = num(height, 76);
  const src = SOURCES.find((s) => s.id === (SAMPLES[sample] ?? SAMPLES.kick).id)!;
  const len = src.frames / 2;
  const clip = demoClip(src.id, 0, 0, {
    len,
    gainDb: num(gainDb, 0),
    fadeIn: num(fadeIn, 0) * len,
    fadeOut: num(fadeOut, 0) * len,
    envelope: flag(envelope)
      ? [
          { at: 0, gain: 0.55 },
          { at: len * 0.35, gain: 1 },
          { at: len * 0.9, gain: 0.8 },
        ]
      : [],
  });
  const t = track({ category, color }, useId());
  const index = num(number, 1) - 1;
  return (
    <WithSession>
      <div className="lane kit-lane" style={{ width: w, height: h }}>
        <ClipView
          clip={clip}
          track={t}
          color={trackColor(index, t.color, t.category)}
          height={h}
          view={{ start: 0, fpp: len / w }}
          width={w}
          selected={flag(selected)}
          toFrame={() => 0}
        />
      </div>
    </WithSession>
  );
}

/** The Timeline panel as the app draws it: header, ruler, tracks, clips. */
export function TimelinePanel() {
  return (
    <WithSession>
      <div className="dhost dhost-timeline kit-panel">
        <TimelineHead />
        <main className="arrangement">
          <Editor />
        </main>
      </div>
    </WithSession>
  );
}

/* ------------------------------------------------------------------ */
/* Mixer                                                               */
/* ------------------------------------------------------------------ */

/** One mixer strip: number and name, pan, mute and solo, volume with its
 * meter, and where it sends. `master` draws C0. */
export function MixerStrip({
  number = 1,
  master,
  selected,
  ...p
}: {
  name?: string;
  number?: Num;
  category?: string;
  color?: Num;
  gainDb?: Num;
  pan?: Num;
  muted?: Flag;
  solo?: Flag;
  selected?: Flag;
  master?: Flag;
}) {
  const s = useSession((x) => x.session);
  const id = useId();
  const isMaster = flag(master);
  const index = num(number, 1) - 1;
  const t = track(p, id);
  const ref = useClassOn("sel", flag(selected));
  if (!s) return null;
  const chan = {
    id: isMaster ? MASTER : id,
    index: isMaster ? -1 : index,
    track: isMaster ? null : t,
    name: isMaster ? "Master" : t.name,
    number: isMaster ? 0 : num(number, 1),
    color: isMaster ? MASTER_COLOR : trackColor(index, t.color, t.category),
    db: isMaster ? num(p.gainDb, -1) : t.gainDb,
    chain: [],
  };
  return (
    <div ref={ref} className="mixer kit-strip">
      <Strip c={chan} s={s} sel={null} onMenu={noop} onSourceDown={noop} />
    </div>
  );
}

/** The Mixer panel as the app draws it: master, a strip per channel, cables. */
export function MixerPanel() {
  return (
    <WithSession>
      <div className="dhost dhost-mixer kit-panel">
        <AppMixerPanel />
      </div>
    </WithSession>
  );
}

/* ------------------------------------------------------------------ */
/* Chain                                                               */
/* ------------------------------------------------------------------ */

const DEVICES: Record<DeviceKind, (id: number, on: boolean) => DeviceState> = {
  eq: eqDevice,
  compressor: compDevice,
  utility: utilityDevice,
};

/** A device card: power, name, menu and its controls. `kind`: eq,
 * compressor or utility. */
export function DeviceCard({
  kind = "compressor",
  name,
  on = true,
  folded,
  selected,
  category = "vox",
}: {
  kind?: DeviceKind;
  name?: string;
  on?: Flag;
  folded?: Flag;
  selected?: Flag;
  category?: string;
}) {
  const id = useId();
  const device = (DEVICES[kind] ?? DEVICES.compressor)(id, on === undefined ? true : flag(on));
  void defaultParams;
  return (
    <WithSession>
      <div className="cards kit-cards">
        <AppDeviceCard
          device={device}
          name={name ?? deviceNames([device])[0]}
          color={trackColor(0, null, category)}
          selected={flag(selected)}
          folded={flag(folded)}
          listen={false}
          onSelect={noop}
          onFold={noop}
          onMenu={noop}
          onSidechain={noop}
        />
      </div>
    </WithSession>
  );
}

/** The Chain panel as the app draws it: the selected channel's devices. */
export function ChainPanel() {
  return (
    <WithSession>
      <div className="dhost dhost-chain kit-panel">
        <AppChainPanel />
      </div>
    </WithSession>
  );
}

/* ------------------------------------------------------------------ */
/* Browser, history, dialogs                                           */
/* ------------------------------------------------------------------ */

/** The Browser panel: search, pinned and recent files, labels, folders. */
export function BrowserPanel() {
  return (
    <WithSession>
      <div className="dhost dhost-browser kit-panel">
        <Browser />
      </div>
    </WithSession>
  );
}

/** The History dropdown: each edit, newest last, with where and what. */
export function HistoryPanel() {
  return (
    <WithSession>
      <div className="histwrap kit-history">
        <AppHistoryPanel onClose={noop} />
      </div>
    </WithSession>
  );
}

/** The Export dialog, open, over its scrim. */
export function ExportDialog() {
  useEffect(() => {
    useSession.setState({ exportOpen: true });
    return () => useSession.setState({ exportOpen: false });
  }, []);
  return (
    <WithSession>
      <AppExportDialog />
    </WithSession>
  );
}
