import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorMessage } from "@/lib/app-info";

/** How often a running app looks for a new release. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "restarting"
  | "error";

interface UpdaterState {
  status: UpdateStatus;
  /** Version that is downloading or ready to apply. */
  pendingVersion: string | null;
  /** Release notes for the pending version, when the feed has any. */
  releaseNotes: string | null;
  downloadProgress: number;
  error: string | null;
  lastChecked: number | null;

  /** Internal: the Tauri Update resource between check and install. */
  _update: Update | null;

  /** Called once on startup with whether this build may self-update. */
  init: (enabled: boolean) => void;
  /** Check GitHub Releases; downloads quietly when a new version exists. */
  checkNow: () => Promise<void>;
  /** Install the downloaded update and relaunch. Only ever called from a user click. */
  restart: () => Promise<void>;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: "disabled",
  pendingVersion: null,
  releaseNotes: null,
  downloadProgress: 0,
  error: null,
  lastChecked: null,
  _update: null,

  init: (enabled) => {
    set({ status: enabled ? "idle" : "disabled" });
  },

  checkNow: async () => {
    const { status } = get();
    // Nothing to do while disabled, busy, or once an update is waiting.
    if (status !== "idle" && status !== "error") return;

    set({ status: "checking", error: null });
    let update: Update | null;
    try {
      update = await check();
    } catch (err) {
      const message = errorMessage(err);
      // A release whose Windows asset hasn't uploaded yet: not an error.
      if (message.includes("fallback platforms")) {
        set({ status: "idle", lastChecked: Date.now() });
      } else {
        set({ status: "error", error: message, lastChecked: Date.now() });
      }
      return;
    }

    set({ lastChecked: Date.now() });
    if (!update) {
      set({ status: "idle" });
      return;
    }

    set({
      status: "downloading",
      pendingVersion: update.version,
      releaseNotes: update.body?.trim() || null,
      downloadProgress: 0,
      _update: update,
    });
    try {
      let total = 0;
      let done = 0;
      // Download only. On Windows `install()` quits the app straight away to
      // run the installer, so it waits for the user's click in `restart`.
      await update.download((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress" && total > 0) {
          done += event.data.chunkLength;
          set({ downloadProgress: Math.min(100, Math.round((done / total) * 100)) });
        }
      });
      set({ status: "ready", downloadProgress: 100 });
    } catch (err) {
      set({ status: "error", error: errorMessage(err), _update: null });
    }
  },

  restart: async () => {
    const { _update } = get();
    if (!_update) return;
    // Later milestones gate this on playback, export and unsaved work.
    set({ status: "restarting" });
    try {
      // Windows: exits here, the installer runs passively and relaunches the
      // app. Elsewhere install returns and we relaunch ourselves.
      await _update.install();
      await relaunch();
    } catch (err) {
      set({ status: "error", error: errorMessage(err) });
    }
  },
}));

/** One line on where the updater stands, for the menu and the title-bar button. */
export function updateLine(status: UpdateStatus, lastChecked: number | null): string {
  switch (status) {
    case "disabled":
      return "Updates are off in dev builds";
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return "Downloading an update…";
    case "ready":
      return "An update is ready";
    case "restarting":
      return "Restarting…";
    case "error":
      return "The last update check failed";
    default:
      return lastChecked
        ? `Up to date, checked ${new Date(lastChecked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : "Not checked yet";
  }
}
