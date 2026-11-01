import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, apiMessage, isApiError, type Codec, type ExportOptions } from "./api";
import { dirOf, stem } from "./format";
import { flushSettings, setSetting, setting } from "./settings";
import { flushLibrary } from "@/stores/library-store";
import { flushViews } from "./view-memory";
import { collapseBrowserForNextScratch } from "@/stores/browser-store";
import { enqueue, useSession } from "@/stores/session-store";

const WAV = { name: "WAV audio", extensions: ["wav", "wave"] };
const MP3 = { name: "MP3 audio", extensions: ["mp3"] };
const PROJECT = { name: "dawg project", extensions: ["dawg"] };
const AUDIO_FILTERS = [{ name: "Audio files", extensions: ["wav", "wave", "mp3"] }, WAV, MP3];
const OPEN_FILTERS = [{ name: "Audio and projects", extensions: ["wav", "wave", "mp3", "dawg"] }, PROJECT, WAV, MP3];

export function isAudio(path: string): boolean {
  return /\.(wave?|mp3)$/i.test(path);
}

export function isProject(path: string): boolean {
  return /\.dawg$/i.test(path);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The folder dialogs start in: the open file's or project's. */
function sessionDir(): string | undefined {
  const s = useSession.getState().session;
  const at = s?.project ?? s?.path;
  return at ? dirOf(at) : undefined;
}

/** Open a WAV or MP3, or a project, in a tab of its own (or bring its tab
 * to the front). Any further audio files go onto tracks of their own.
 * `outside`: the file came from outside the window ("Edit in dawg", Unity),
 * so a scratch tab starts with the Browser collapsed. */
export function openPath(path: string, more: string[] = [], outside = false) {
  collapseBrowserForNextScratch(outside);
  void useSession
    .getState()
    .open(path)
    .finally(() => collapseBrowserForNextScratch(false))
    .then((ok) => {
      if (!ok) return;
      const now = useSession.getState().session;
      if (more.length && now?.scratch) {
        void useSession.getState().importFiles(more, { track: null, start: 0 });
      }
      if (now) offerLocate();
    });
}

/** Says when a project's audio files weren't found, with a way to find them. */
function offerLocate() {
  const s = useSession.getState();
  const missing = s.session?.sources.filter((x) => x.missing) ?? [];
  if (!missing.length) return;
  const what = missing.length === 1 ? `${missing[0].name} wasn't found` : `${missing.length} audio files weren't found`;
  s.showToast(`${what}; those clips play silence`, {
    error: true,
    action: { label: "Locate…", run: () => void locateSource(missing[0].id) },
  });
}

/** Asks where a missing source's file went. Others missing from the same
 * folder are found with it. */
export async function locateSource(id: number) {
  if (!isTauri()) return;
  const s = useSession.getState();
  const src = s.session?.sources.find((x) => x.id === id);
  if (!src) return;
  const picked = await open({
    multiple: false,
    directory: false,
    title: `Locate ${src.name}`,
    filters: AUDIO_FILTERS,
    defaultPath: sessionDir(),
  });
  if (typeof picked !== "string") return;
  try {
    const r = await enqueue(() => api.relinkSource(id, picked));
    useSession.getState().reloaded(r.state);
    s.showToast(r.relinked > 1 ? `Found ${r.relinked} files` : `Found ${src.name}`);
    offerLocate();
  } catch (e) {
    s.showToast(`Couldn't use ${fileName(picked)}: ${apiMessage(e)}`, { error: true });
  }
}

const PROJECT_DIR_KEY = "lastProjectDir";

function remembered(key: string): string | null {
  const v = setting<unknown>(key, null);
  return typeof v === "string" && v ? v : null;
}

function remember(key: string, value: string) {
  setSetting(key, value);
}

/** Saves the project where it was saved before, or asks where. A scratch
 * session asks, and becomes a project. Returns true when it saved. */
export async function saveProject(): Promise<boolean> {
  const s = useSession.getState();
  if (!s.session || !isTauri()) return false;
  if (!s.session.project) return saveProjectAs();
  return writeProject(null);
}

/** Saves the session as a project somewhere new. */
export async function saveProjectAs(): Promise<boolean> {
  const s = useSession.getState();
  if (!s.session || !isTauri()) return false;
  const { project, path, name } = s.session;
  const dir = project ? dirOf(project) : (remembered(PROJECT_DIR_KEY) ?? (path ? dirOf(path) : ""));
  const base = project ? stem(name) : path ? stem(name) : "Untitled";
  const picked = await save({ filters: [PROJECT], defaultPath: `${dir}${base}.dawg` });
  if (!picked) return false;
  return writeProject(isProject(picked) ? picked : `${picked}.dawg`);
}

async function writeProject(path: string | null): Promise<boolean> {
  const s = useSession.getState();
  useSession.setState({ busy: "Saving…" });
  try {
    await s.commit();
    const state = await enqueue(() => api.saveProject(path));
    s.adopt(state);
    if (state.project) remember(PROJECT_DIR_KEY, dirOf(state.project));
    s.showToast(`Saved ${state.name}`);
    return true;
  } catch (e) {
    s.showToast(`Couldn't save the project: ${apiMessage(e)}`, { error: true });
    return false;
  } finally {
    useSession.setState({ busy: null });
  }
}

/** Ctrl+S: saves a project; in a scratch session it opens Export, which
 * starts on the original (Replace), as the UX spec has it. */
export function saveOrExport() {
  const s = useSession.getState().session;
  if (!s) return;
  if (s.scratch) void exportDialog();
  else void saveProject();
}

/** An empty project in a new tab. */
export function newProject() {
  void useSession.getState().newProject();
}

/** Closes the tab in front (asking about unsaved edits); with none open,
 * the window. */
export function closeFrontTab() {
  const s = useSession.getState();
  if (s.activeTab === null) requestClose();
  else void s.closeTab(s.activeTab);
}

/** Ctrl+Tab and Ctrl+Shift+Tab: the next or previous tab, round the row. */
export function cycleTab(by: number) {
  const s = useSession.getState();
  const i = s.tabs.findIndex((t) => t.id === s.activeTab);
  if (i < 0 || s.tabs.length < 2) return;
  void s.switchTab(s.tabs[(i + by + s.tabs.length) % s.tabs.length].id);
}

/** The tabs with unsaved edits; the front one's as it is now. */
export function unsavedTabs() {
  const s = useSession.getState();
  return s.tabs
    .map((t) => (t.id === s.activeTab && s.session ? { ...t, name: s.session.name, dirty: s.session.dirty } : t))
    .filter((t) => t.dirty);
}

export async function openProjectDialog() {
  if (!isTauri()) return;
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [PROJECT],
    defaultPath: remembered(PROJECT_DIR_KEY) ?? sessionDir(),
  });
  if (typeof picked === "string") openPath(picked);
}

export async function openRecent(path: string) {
  const list = await api.recentProjects().catch(() => []);
  if (list.some((r) => r.path === path && !r.exists)) {
    void api.forgetRecentProject(path);
    useSession.getState().showToast(`${fileName(path)} isn't there any more`, { error: true });
    return;
  }
  openPath(path);
}

/** Add files to the open session, each on a new track at the playhead. */
export async function addFilesDialog() {
  if (!isTauri()) return;
  const s = useSession.getState();
  const picked = await open({
    multiple: true,
    directory: false,
    filters: AUDIO_FILTERS,
    defaultPath: sessionDir(),
  });
  const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
  if (!paths.length) return;
  if (!s.session) openPath(paths[0], paths.slice(1));
  else await s.importFiles(paths, { track: null, start: s.playhead });
}

export async function openFileDialog() {
  if (!isTauri()) return;
  const picked = await open({
    multiple: false,
    directory: false,
    filters: OPEN_FILTERS,
    defaultPath: sessionDir(),
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
 * Export the edit through the system save dialog. For a plain edit of the
 * original it starts on that file, so Save there asks (in the dialog itself)
 * whether to replace it; that path goes through the safe replace with a
 * backup. A mixdown of several clips starts on "<name> mix" instead. The file
 * type picks WAV or MP3; the original's format comes first.
 */
/** The last export from this window, and the file it was made from. */
let lastExport: { from: string; to: string } | null = null;
const EXPORT_DIR_KEY = "lastExportDir";

/** Folder of the last export, kept across restarts. */
function lastExportDir(): string | null {
  return remembered(EXPORT_DIR_KEY);
}

/** Export: a scratch file's own edit goes straight to the save dialog
 * (Replace when saved over the original); a mixdown opens the Export dialog
 * for its range and format first. */
export async function exportDialog(): Promise<boolean> {
  const s = useSession.getState();
  if (!s.session || !isTauri()) return false;
  await s.stop();
  if (s.session.simple) return exportTo(null, null);
  useSession.setState({ exportOpen: true });
  return false;
}

/** The save dialog, then the export with `options` as `codec` (null: the
 * session's own). */
export async function exportTo(options: ExportOptions | null, codec: Codec | null): Promise<boolean> {
  const s = useSession.getState();
  if (!s.session || !isTauri()) return false;
  const want = codec ?? s.session.codec;
  const filters = want === "mp3" ? [MP3, WAV] : [WAV, MP3];
  // After an export from this file, the next one starts where that went.
  // Before that, just the original file's clip saves over it (the "Edit in
  // dawg" round trip); a mix starts as a new file in the last export folder,
  // or next to the original, so the original isn't replaced by accident.
  // A project exports next to itself (an untitled one to the last export
  // folder), named after it.
  const original = s.session.path;
  const from = original ?? s.session.project ?? "";
  const ext = want === "mp3" ? "mp3" : "wav";
  const mixDir = (s.session.project && dirOf(s.session.project)) || lastExportDir() || (original ? dirOf(original) : "");
  const defaultPath =
    lastExport && lastExport.from === from
      ? lastExport.to.replace(/\.(wave?|mp3)$/i, `.${ext}`)
      : s.session.simple && original
        ? original
        : `${mixDir}${stem(s.session.name)}${s.session.scratch ? " mix" : ""}.${ext}`;
  const path = await save({ filters, defaultPath });
  if (!path) return false;
  lastExport = { from, to: path };
  remember(EXPORT_DIR_KEY, dirOf(path));
  useSession.setState({ busy: "Saving…" });
  try {
    await api.saveAs(path, options);
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

/** Closes the window for good. */
function closeWindow() {
  // Closing on purpose: nothing to recover next time.
  void api
    .clearAutosave()
    .catch(() => undefined)
    .then(() => Promise.all([flushSettings(), flushViews(), flushLibrary()]))
    .finally(() => void getCurrentWindow().destroy());
}

/** Close the window, asking first about unsaved edits: one unsaved tab asks
 * as closing that tab would, several ask once with the list. */
export async function requestClose() {
  if (!isTauri()) return;
  const unsaved = unsavedTabs();
  if (!unsaved.length) {
    closeWindow();
    return;
  }
  if (unsaved.length > 1) {
    useSession.getState().setDialog({ type: "quit", tabs: unsaved });
    return;
  }
  await reviewUnsaved();
}

/** Asks about each unsaved tab in turn, then closes the window. */
export async function reviewUnsaved() {
  const s = useSession.getState();
  const next = unsavedTabs()[0];
  if (!next) {
    closeWindow();
    return;
  }
  await s.switchTab(next.id);
  if (useSession.getState().activeTab !== next.id) return;
  useSession.getState().guard("close dawg", () => {
    // Saved or let go: this tab is done; on to the next.
    void useSession
      .getState()
      .dropTab(next.id)
      .then(() => void reviewUnsaved());
  });
}

/** Closes the window, letting every unsaved edit go. */
export function discardAllAndClose() {
  closeWindow();
}
