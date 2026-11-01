import { create } from "zustand";
import { DEFAULT_PRESET, PRESETS, validate, type Layout, type PanelId, type PresetName } from "@/lib/layout";
import { setSetting, setting } from "@/lib/settings";

/** The panel layout, remembered in settings.json as `layout`. */
interface LayoutState {
  layout: Layout;
  /** The preset the layout still matches, for the menu's check mark. */
  preset: PresetName | null;
  /** The header menu: which panel, where. */
  menu: { panel: PanelId; x: number; y: number } | null;
  set: (layout: Layout) => void;
  applyPreset: (name: PresetName) => void;
  openMenu: (panel: PanelId, x: number, y: number) => void;
  closeMenu: () => void;
}

function initial(): { layout: Layout; preset: PresetName | null } {
  const saved = validate(setting<unknown>("layout", null));
  if (saved) return { layout: saved, preset: setting<PresetName | null>("layoutPreset", null) };
  // First run with panels: keep the Browser width people had set.
  const w = setting<{ width?: unknown } | null>("browser", null)?.width;
  const bw = typeof w === "number" && Number.isFinite(w) ? Math.round(w) : undefined;
  return { layout: PRESETS[DEFAULT_PRESET].make(bw), preset: DEFAULT_PRESET };
}

export const useLayout = create<LayoutState>((set) => ({
  ...initial(),
  menu: null,
  set: (layout) => {
    setSetting("layout", layout);
    setSetting("layoutPreset", null);
    set({ layout, preset: null });
  },
  applyPreset: (name) => {
    const layout = PRESETS[name].make();
    setSetting("layout", layout);
    setSetting("layoutPreset", name);
    set({ layout, preset: name, menu: null });
  },
  openMenu: (panel, x, y) => set({ menu: { panel, x, y } }),
  closeMenu: () => set({ menu: null }),
}));
