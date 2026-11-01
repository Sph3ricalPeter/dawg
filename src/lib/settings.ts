import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * App-wide UI settings, remembered between launches: panel sizes and
 * toggles, the Browser's folders and pins, units and snap, export choices.
 * Per-project state (tracks, zoom, ranges) belongs to the project file.
 *
 * In the app they live in `settings.json` in the app's data folder
 * (`src-tauri/src/settings.rs`); localStorage alone can lose the last
 * changes when the window closes. In a plain browser they fall back to
 * localStorage. `loadSettings` runs before the stores are created, so
 * reading a setting is synchronous.
 */

type Settings = Record<string, unknown>;

const LOCAL_KEY = "dawg.settings";
/** Where each setting lived before this file (localStorage, one key each). */
const LEGACY: Record<string, { key: string; json: boolean }> = {
  browser: { key: "dawg.browser", json: true },
  export: { key: "dawg.export", json: true },
  units: { key: "dawg.units", json: false },
  snap: { key: "dawg.snap", json: false },
  snapScratch: { key: "dawg.snapScratch", json: false },
  lastProjectDir: { key: "dawg.lastProjectDir", json: false },
  lastExportDir: { key: "dawg.lastExportDir", json: false },
};

let values: Settings = {};
let timer = 0;
let writing: Promise<void> = Promise.resolve();

function local(): Settings | null {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "null") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Settings) : null;
  } catch {
    return null;
  }
}

/** Settings an older version kept in separate localStorage keys. */
function legacy(): Settings {
  const out: Settings = {};
  for (const [name, { key, json }] of Object.entries(LEGACY)) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === "") continue;
      out[name] = json ? JSON.parse(raw) : raw;
    } catch {
      // Unreadable: the default it is.
    }
  }
  return out;
}

/** Reads the saved settings. Call once, before the stores are imported. */
export async function loadSettings(): Promise<void> {
  if (isTauri()) {
    let saved: Settings | null = null;
    try {
      saved = await invoke<Settings | null>("load_settings");
    } catch {
      // No file to read: start from defaults.
    }
    if (saved) {
      values = saved;
    } else {
      // First run with the settings file: bring over what localStorage had.
      values = { ...legacy(), ...(local() ?? {}) };
      if (Object.keys(values).length) persist();
    }
  } else {
    values = local() ?? legacy();
  }
}

/** A saved setting, or `fallback` when there is none. */
export function setting<T>(name: string, fallback: T): T {
  return name in values ? (values[name] as T) : fallback;
}

/** A saved string setting that must be one of `allowed`. */
export function choice<T extends string | number>(name: string, allowed: readonly T[], fallback: T): T {
  const v = values[name] as T;
  return allowed.includes(v) ? v : fallback;
}

/** Remembers a setting; null forgets it. Saved shortly after. */
export function setSetting(name: string, value: unknown) {
  if (value === null || value === undefined) delete values[name];
  else values[name] = value;
  window.clearTimeout(timer);
  timer = window.setTimeout(persist, 250);
}

function persist() {
  window.clearTimeout(timer);
  timer = 0;
  const snapshot = { ...values };
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot));
  } catch {
    // Only a fallback.
  }
  if (isTauri()) {
    writing = writing
      .then(() => invoke<void>("save_settings", { settings: snapshot }))
      .catch(() => undefined);
  }
}

/** Saves now: before the window closes or the app restarts. */
export function flushSettings(): Promise<void> {
  if (timer) persist();
  return writing;
}
