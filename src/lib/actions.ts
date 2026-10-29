import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, apiMessage, isApiError } from "./api";
import { dirOf } from "./format";
import { useSession } from "@/stores/session-store";

const WAV = { name: "WAV audio", extensions: ["wav", "wave"] };
const MP3 = { name: "MP3 audio", extensions: ["mp3"] };
const OPEN_FILTERS = [{ name: "Audio files", extensions: ["wav", "wave", "mp3"] }, WAV, MP3];

export function isAudio(path: string): boolean {
  return /\.(wave?|mp3)$/i.test(path);
}

/** Open a WAV or MP3 (asks before dropping unsaved edits). */
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
    filters: OPEN_FILTERS,
    defaultPath: s.session ? dirOf(s.session.path) : undefined,
  });
  if (typeof picked === "string") openPath(picked);
}

/** Writes the edit over the original. Returns true when it did. */
async function replaceOriginal(): Promise<boolean> {
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

/**
 * Export the edit through the system save dialog. It starts on the original
 * file, so Save there asks (in the dialog itself) whether to replace it;
 * that path goes through the safe replace with a backup. The file type
 * picks WAV or MP3; the file's own format comes first.
 */
export async function exportDialog(): Promise<boolean> {
  const s = useSession.getState();
  if (!s.session || !isTauri()) return false;
  await s.stop();
  const filters = s.session.codec === "mp3" ? [MP3, WAV] : [WAV, MP3];
  const path = await save({ filters, defaultPath: s.session.path });
  if (!path) return false;
  useSession.setState({ busy: "Saving…" });
  try {
    await api.saveAs(path);
    s.showToast(`Exported ${path.split(/[\\/]/).pop()}`);
    return true;
  } catch (e) {
    if (isApiError(e) && e.kind === "same_file") {
      useSession.setState({ busy: null });
      return replaceOriginal();
    }
    s.showToast(`Couldn't export: ${apiMessage(e)}`, { error: true });
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
