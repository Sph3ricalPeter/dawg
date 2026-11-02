import { create } from "zustand";
import { setSetting, setting } from "@/lib/settings";

/** The Mixer panel's options (its ⋯ menu), saved with the UI settings. */
export interface MixerOptions {
  /** Narrow: half-width strips, no device lists (the Chain panel does the
   * device work). Expanded: FL-style device lists, a click opens one in a
   * floating panel. */
  layout: "narrow" | "expanded";
  meters: "wide" | "narrow";
  /** Fader, a slim fader, the knob over a full meter, or the track row's
   * own small control. */
  vol: "fader" | "mini" | "knob" | "compact";
  /** Other channels' cables: grey, or hidden (the selected channel's
   * always show). */
  cables: "grey" | "hidden";
}

const DEFAULTS: MixerOptions = { layout: "narrow", meters: "wide", vol: "fader", cables: "grey" };

const CHOICES: { [K in keyof MixerOptions]: readonly MixerOptions[K][] } = {
  layout: ["narrow", "expanded"],
  meters: ["wide", "narrow"],
  vol: ["fader", "mini", "knob", "compact"],
  cables: ["grey", "hidden"],
};

function load(): MixerOptions {
  const saved = setting<Partial<Record<string, unknown>> | null>("mixer", null) ?? {};
  const out = { ...DEFAULTS };
  for (const k of Object.keys(CHOICES) as (keyof MixerOptions)[]) {
    const v = saved[k];
    if ((CHOICES[k] as readonly unknown[]).includes(v)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

interface MixerStore {
  options: MixerOptions;
  setOption: <K extends keyof MixerOptions>(key: K, value: MixerOptions[K]) => void;
}

export const useMixer = create<MixerStore>((set, get) => ({
  options: load(),
  setOption: (key, value) => {
    const options = { ...get().options, [key]: value };
    setSetting("mixer", options);
    set({ options });
  },
}));
