import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, apiMessage, isApiError } from "./api";
import { dirOf, stem } from "./format";
import { useSession } from "@/stores/session-store";

const WAV_FILTER = [{ name: "WAV audio", extensions: ["wav", "wave"] }];
const CLOSE_AFTER_KEY = "dawg.closeAfterReplace";

export function closeAfterReplace(): boolean {
  try {
    return localStorage.getItem(CLOSE_AFTER_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setCloseAfterReplace(on: boolean) {
  try {
    localStorage.setItem(CLOSE_AFTER_KEY, on ? "1" : "0");
  } catch {
    // Only a remembered preference.
  }
}

export function isWav(path: string): boolean {
  return /\.wave?$/i.test(path);
}

/** Open a WAV (asks before dropping unsaved edits). */
export function openPath(path: string) {
  const s = useSession.getState();
  s.guard("open another file", () => void s.open(path));
}

export async function openFileDialog() {
  if (!isTauri()) return;
  const s = useSession.getState();
  const picked = await open({
    multiple: false,
    directory: false,
    filters: WAV_FILTER,
    defaultPath: s.session ? dirOf(s.session.path) : undefined,
  });
  if (typeof picked === "string") openPath(picked);
}

export function showReplaceDialog() {
  const s = useSession.getState();
  if (!s.session) return;
  void s.stop();
  s.setDialog({ type: "replace" });
}

/** Writes the edit over the original. Returns true when it did. */
export async function replaceOriginal(): Promise<boolean> {
  const s = useSession.getState();
  if (!s.session) return false;
  const name = s.session.name;
  useSession.setState({ busy: "Replacing…" });
  try {
    const r = await api.replaceOriginal();
    s.reloaded(r.state);
    s.showToast(`Replaced ${name}. The old version is backed up.`, {
      action: { label: "Restore", run: () => void restoreLastReplace() },
    });
    return true;
  } catch (e) {
    const prefix =
      isApiError(e) && e.kind === "in_use" ? `${name} is in use` : `Couldn't replace ${name}`;
    s.showToast(`${prefix}: ${apiMessage(e)}`, { error: true });
    return false;
  } finally {
    useSession.setState({ busy: null });
  }
}

/** Replace, then close the window if the user asked for that. */
export async function replaceAndMaybeClose(close: boolean) {
  const ok = await replaceOriginal();
  if (ok && close && isTauri()) await getCurrentWindow().destroy();
}

export async function saveAsDialog(): Promise<boolean> {
  const s = useSession.getState();
  if (!s.session || !isTauri()) return false;
  const path = await save({
    filters: WAV_FILTER,
    defaultPath: `${dirOf(s.session.path)}${stem(s.session.name)}_edit.wav`,
  });
  if (!path) return false;
  useSession.setState({ busy: "Saving…" });
  try {
    await api.saveAs(path);
    s.showToast(`Saved ${path}`);
    return true;
  } catch (e) {
    s.showToast(`Couldn't save: ${apiMessage(e)}`, { error: true });
    return false;
  } finally {
    useSession.setState({ busy: null });
  }
}

export async function restoreLastReplace() {
  const s = useSession.getState();
  const last = await api.lastReplace().catch(() => null);
  if (!last) {
    s.showToast("There's no replaced file to restore");
    return;
  }
  const editingIt = s.session && s.session.path === last.original;
  const run = async () => {
    try {
      const state = await api.restoreLastReplace();
      if (editingIt) s.reloaded(state);
      s.showToast(`Restored ${last.original.split(/[\\/]/).pop()}`);
    } catch (e) {
      s.showToast(`Couldn't restore: ${apiMessage(e)}`, { error: true });
    }
  };
  if (editingIt) s.guard("restore the previous version", () => void run());
  else await run();
}

/** Close the window, asking first about unsaved edits. */
export function requestClose() {
  if (!isTauri()) return;
  useSession.getState().guard("close dawg", () => void getCurrentWindow().destroy());
}
