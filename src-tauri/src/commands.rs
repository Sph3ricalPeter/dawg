//! IPC commands for the editing session. The UI never touches samples: it
//! sends [`Command`]s, gets [`SessionState`] back and asks for peaks.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use dawg_cli::tools::{self, Ctx, Selection, Take, Tools};
use dawg_core::file::Codec;
use dawg_core::save::{self, Replaced};
use dawg_core::session::{
    self, ExportOptions, Imported, Placement, SavePreview, Session, SessionState,
};
use dawg_core::{Command, Project};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::audio::Audio;
use crate::autosave;
use crate::recent::{self, Recent};

pub struct AppState {
    inner: Mutex<Inner>,
}

/// One open session: a tab in the title bar.
struct Tab {
    id: u64,
    /// Always set, except while an agent's tool replaces it.
    slot: Option<Session>,
    /// An agent's take under way on this tab.
    take: Option<Take>,
}

struct Inner {
    /// Open sessions, in tab order.
    tabs: Vec<Tab>,
    /// The tab in front: the one that plays and that edits go to.
    active: Option<u64>,
    next_tab: u64,
    audio: Audio,
    /// A file named on the command line ("Edit in dawg", Unity's external
    /// editor), or handed over by a second launch, until the UI takes it.
    pending_file: Option<PathBuf>,
    /// The UI's selection, for an agent's `get_selection`.
    selection: Selection,
}

/// A tab as the title bar shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    id: u64,
    name: String,
    scratch: bool,
    dirty: bool,
    /// The audio file a scratch tab edits, or the project's file.
    path: Option<PathBuf>,
}

/// The tabs, and the one in front with its state.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Front {
    tabs: Vec<TabInfo>,
    active: Option<u64>,
    state: Option<SessionState>,
    /// It was already open, so its tab came to the front instead.
    existing: bool,
}

impl AppState {
    pub fn new(startup_file: Option<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                tabs: Vec::new(),
                active: None,
                next_tab: 1,
                audio: Audio::default(),
                pending_file: startup_file,
                selection: Selection::default(),
            }),
        }
    }

    /// Queues a file for the UI to open (see [`startup_file`]).
    pub fn request_open(&self, path: PathBuf) {
        self.lock().pending_file = Some(path);
    }

    /// An MCP tool call from `dawg-cli mcp`, on the tab in front. Opening a
    /// file or starting a project gets a tab of its own, unless the tab in
    /// front is a blank project. Also returns whether the session changed,
    /// and if so whether the tabs did (opened or new) rather than an edit.
    pub fn agent_call(
        &self,
        tool: &str,
        args: &serde_json::Value,
        backups: &Path,
    ) -> (
        std::result::Result<Vec<serde_json::Value>, String>,
        Option<bool>,
    ) {
        let mut s = self.lock();
        let selection = s.selection.clone();
        let ctx = || Ctx {
            backups,
            attached: true,
            selection: Some(&selection),
        };
        if tools::REPLACES.contains(&tool) {
            // A file that is already open comes to the front as it is.
            let open_path = (tool == "open")
                .then(|| args.get("path").and_then(serde_json::Value::as_str))
                .flatten()
                .map(PathBuf::from);
            if let Some(id) = open_path.as_deref().and_then(|p| s.tab_with(p)) {
                s.activate(id);
                let tab = s.front_tab_mut().expect("just activated");
                let r = Tools {
                    slot: &mut tab.slot,
                    take: &mut tab.take,
                    ctx: ctx(),
                }
                .call("get_project", args);
                s.selection = Selection::default();
                return (r, Some(true));
            }
            let mut slot = None;
            let mut take = None;
            let r = Tools {
                slot: &mut slot,
                take: &mut take,
                ctx: ctx(),
            }
            .call(tool, args);
            let opened = r.is_ok() && slot.is_some();
            if let Some(session) = slot.filter(|_| r.is_ok()) {
                s.open_tab(session);
                s.selection = Selection::default();
            }
            return (r, opened.then_some(true));
        }
        let Some(tab) = s.front_tab_mut() else {
            return (
                Err("nothing is open: call open or new_project first".into()),
                None,
            );
        };
        let r = Tools {
            slot: &mut tab.slot,
            take: &mut tab.take,
            ctx: ctx(),
        }
        .call(tool, args);
        let changed = r.is_ok() && !tools::READS.contains(&tool);
        if changed {
            s.publish();
        }
        (r, changed.then_some(false))
    }

    /// Plays `project` (a browser preview) from `from` to `to`, leaving the
    /// session to play again on the next Play.
    pub fn preview(
        &self,
        project: Arc<Project>,
        from: u64,
        to: u64,
    ) -> std::result::Result<(), String> {
        self.lock().audio.preview(project, from, to)
    }

    pub fn preview_stop(&self) {
        self.lock().audio.stop_preview();
    }

    /// Whether a preview plays, and its frame.
    pub fn preview_status(&self) -> (bool, u64) {
        self.lock().audio.preview_status()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic mid-command leaves nothing half-applied worth refusing.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A new project nobody has touched: opening a file replaces it rather
/// than leaving it as a tab of its own.
fn blank(s: &Session) -> bool {
    !s.dirty()
        && s.path().is_none()
        && s.project_path().is_none()
        && s.project().clips().next().is_none()
}

impl Inner {
    fn front_tab(&self) -> Option<&Tab> {
        let id = self.active?;
        self.tabs.iter().find(|t| t.id == id)
    }

    fn front_tab_mut(&mut self) -> Option<&mut Tab> {
        let id = self.active?;
        self.tabs.iter_mut().find(|t| t.id == id)
    }

    fn front(&self) -> Option<&Session> {
        self.front_tab()?.slot.as_ref()
    }

    fn session(&mut self) -> Result<&mut Session, Error> {
        self.front_tab_mut()
            .and_then(|t| t.slot.as_mut())
            .ok_or_else(|| Error::new("no_file", "no file is open"))
    }

    /// A tab's session by id, or the front one's.
    fn tab_session(&self, tab: Option<u64>) -> Option<&Session> {
        match tab {
            Some(id) => self.tabs.iter().find(|t| t.id == id)?.slot.as_ref(),
            None => self.front(),
        }
    }

    /// Hands the current snapshot to the player after an edit.
    fn publish(&mut self) {
        if let Some(p) = self.front().map(|s| s.project().clone()) {
            self.audio.set_project(p);
        }
    }

    fn state(&self) -> Option<SessionState> {
        self.front().map(Session::state)
    }

    /// The tab that already has `path` open, as its file or its project.
    fn tab_with(&self, path: &Path) -> Option<u64> {
        self.tabs.iter().find_map(|t| {
            let s = t.slot.as_ref()?;
            let at = s.path().or(s.project_path())?;
            same_file(at, path).then_some(t.id)
        })
    }

    /// Brings tab `id` to the front. Playback stops: only the tab in front
    /// plays.
    fn activate(&mut self, id: u64) {
        if self.active == Some(id) || !self.tabs.iter().any(|t| t.id == id) {
            return;
        }
        self.audio.stop();
        self.active = Some(id);
        self.publish();
    }

    /// Puts `session` in a tab of its own at the front, or in the front
    /// tab's place when that is a blank project.
    fn open_tab(&mut self, session: Session) {
        self.audio.stop();
        let reuse = self
            .front_tab()
            .is_some_and(|t| t.slot.as_ref().is_some_and(blank));
        if reuse {
            let tab = self.front_tab_mut().expect("front tab");
            tab.slot = Some(session);
            tab.take = None;
        } else {
            let id = self.next_tab;
            self.next_tab += 1;
            // Just after the tab in front, as browsers do.
            let at = self
                .active
                .and_then(|a| self.tabs.iter().position(|t| t.id == a))
                .map_or(self.tabs.len(), |i| i + 1);
            self.tabs.insert(
                at,
                Tab {
                    id,
                    slot: Some(session),
                    take: None,
                },
            );
            self.active = Some(id);
        }
        self.publish();
    }

    /// Closes tab `id`; the one to its right (else left) comes to the front.
    fn close_tab(&mut self, id: u64) {
        let Some(i) = self.tabs.iter().position(|t| t.id == id) else {
            return;
        };
        self.tabs.remove(i);
        if self.active == Some(id) {
            self.audio.stop();
            self.active = self.tabs.get(i).or(self.tabs.last()).map(|t| t.id);
            self.publish();
        }
    }

    fn front_info(&self, existing: bool) -> Front {
        Front {
            tabs: self
                .tabs
                .iter()
                .filter_map(|t| {
                    let s = t.slot.as_ref()?;
                    let st = s.state();
                    Some(TabInfo {
                        id: t.id,
                        name: st.name,
                        scratch: st.scratch,
                        dirty: st.dirty,
                        path: st.path.or(st.project),
                    })
                })
                .collect(),
            active: self.active,
            state: self.state(),
            existing,
        }
    }
}

/// The first argument that isn't a flag: Explorer runs `dawg.exe "<file>"`.
/// A relative path is taken from `cwd`, the launching process's folder.
///
/// The arguments can arrive split at spaces: after a Windows update the
/// installer relaunches dawg with the arguments it was started with, but
/// loses their quotes on the way, so `"Sph3rical - Wave3.wav"` comes back
/// as `Sph3rical`, `-`, `Wave3.wav`. When the first argument isn't a file,
/// the ones after it are joined back on, one at a time, until they are.
pub fn file_from_args(args: impl Iterator<Item = OsString>, cwd: &Path) -> Option<PathBuf> {
    let args: Vec<String> = args.map(|a| a.to_string_lossy().into_owned()).collect();
    let first = args.iter().position(|a| !a.starts_with('-'))?;
    let mut joined = args[first].clone();
    for more in &args[first + 1..] {
        if cwd.join(&joined).is_file() {
            break;
        }
        joined.push(' ');
        joined.push_str(more);
        if cwd.join(&joined).is_file() {
            return Some(cwd.join(joined));
        }
    }
    Some(cwd.join(&args[first]))
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, Error> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| Error::new("io", e.to_string()))
}

pub(crate) fn backup_dir(app: &AppHandle) -> Result<PathBuf, Error> {
    data_dir(app).map(|d| d.join("backups"))
}

fn remember(app: &AppHandle, project: &Path) {
    if let Ok(dir) = data_dir(app) {
        recent::add(&dir, project);
    }
}

pub fn prune_backups(app: &AppHandle) {
    if let Ok(dir) = backup_dir(app) {
        std::thread::spawn(move || save::prune_backups(&dir));
    }
}

/// An error the UI can show and branch on.
#[derive(Debug, Serialize)]
pub struct Error {
    kind: &'static str,
    pub(crate) message: String,
}

impl Error {
    pub(crate) fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

pub(crate) type Result<T, E = Error> = std::result::Result<T, E>;

/// The file waiting to be opened, if any. The UI asks once on load and again
/// whenever the backend emits [`OPEN_REQUESTED`].
#[tauri::command]
pub fn startup_file(state: State<AppState>) -> Option<PathBuf> {
    state.lock().pending_file.take()
}

/// Emitted when a second launch handed this window a file.
pub const OPEN_REQUESTED: &str = "open-requested";

/// Opens a WAV or MP3 as a scratch session, or a `.dawg` project, in a tab
/// of its own. A file that is already open brings its tab to the front.
#[tauri::command]
pub fn open_file(app: AppHandle, state: State<AppState>, path: PathBuf) -> Result<Front> {
    {
        let mut s = state.lock();
        if let Some(id) = s.tab_with(&path) {
            s.activate(id);
            return Ok(s.front_info(true));
        }
    }
    let session = if session::is_project(&path) {
        let s = Session::open_project(&path).map_err(|e| Error::new(e.kind(), e.to_string()))?;
        remember(&app, &path);
        s
    } else {
        Session::open(&path).map_err(|e| Error::new("open", e.to_string()))?
    };
    let mut s = state.lock();
    s.open_tab(session);
    Ok(s.front_info(false))
}

/// Starts an empty project in a new tab.
#[tauri::command]
pub fn new_project(state: State<AppState>) -> Front {
    let mut s = state.lock();
    s.open_tab(Session::new_project());
    s.front_info(false)
}

/// The open tabs and the one in front.
#[tauri::command]
pub fn tabs(state: State<AppState>) -> Front {
    state.lock().front_info(false)
}

/// Brings a tab to the front; playback stops.
#[tauri::command]
pub fn switch_tab(state: State<AppState>, id: u64) -> Front {
    let mut s = state.lock();
    s.activate(id);
    s.front_info(false)
}

/// Closes a tab, unsaved edits and all (the UI has asked).
#[tauri::command]
pub fn close_tab(app: AppHandle, state: State<AppState>, id: u64) -> Front {
    let mut s = state.lock();
    s.close_tab(id);
    // Its autosave goes with it.
    if let Ok(dir) = autosave_dir(&app) {
        let tabs: Vec<_> = s
            .tabs
            .iter()
            .filter_map(|t| Some((t.id, t.slot.as_ref()?)))
            .collect();
        autosave::write(&dir, &tabs);
    }
    s.front_info(false)
}

/// Moves a tab to `index` in the row.
#[tauri::command]
pub fn move_tab(state: State<AppState>, id: u64, index: usize) -> Front {
    let mut s = state.lock();
    if let Some(i) = s.tabs.iter().position(|t| t.id == id) {
        let tab = s.tabs.remove(i);
        let at = index.min(s.tabs.len());
        s.tabs.insert(at, tab);
    }
    s.front_info(false)
}

/// Saves the session as a project: at `path`, or where it was last saved.
#[tauri::command]
pub fn save_project(
    app: AppHandle,
    state: State<AppState>,
    path: Option<PathBuf>,
) -> Result<SessionState> {
    let mut s = state.lock();
    let session = s.session()?;
    let path = path
        .or_else(|| session.project_path().map(Path::to_path_buf))
        .ok_or_else(|| Error::new("no_path", "the project hasn't been saved yet"))?;
    session
        .save_project(&path)
        .map_err(|e| Error::new(e.kind(), e.to_string()))?;
    remember(&app, &path);
    Ok(s.state().expect("session is open"))
}

#[derive(Serialize)]
pub struct RelinkResult {
    state: SessionState,
    /// Sources now playing a file, the one asked for included.
    relinked: usize,
}

/// Points a missing source at a file the user found.
#[tauri::command]
pub fn relink_source(state: State<AppState>, source: u64, path: PathBuf) -> Result<RelinkResult> {
    let mut s = state.lock();
    let relinked = s
        .session()?
        .relink(source, &path)
        .map_err(|e| Error::new("open", e.to_string()))?;
    s.publish();
    Ok(RelinkResult {
        state: s.state().expect("session is open"),
        relinked,
    })
}

#[tauri::command]
pub fn recent_projects(app: AppHandle) -> Vec<Recent> {
    data_dir(&app).map(|d| recent::list(&d)).unwrap_or_default()
}

#[tauri::command]
pub fn forget_recent_project(app: AppHandle, path: PathBuf) {
    if let Ok(dir) = data_dir(&app) {
        recent::remove(&dir, &path);
    }
}

#[tauri::command]
pub fn session_state(state: State<AppState>) -> Option<SessionState> {
    state.lock().state()
}

#[tauri::command]
pub fn apply(state: State<AppState>, command: Command, transient: bool) -> Result<SessionState> {
    let mut s = state.lock();
    s.session()?
        .apply(&command, transient)
        .map_err(|e| Error::new("command", e.to_string()))?;
    s.publish();
    Ok(s.state().expect("session is open"))
}

/// The installed `dawg-cli` next to this app, for the MCP setup hint.
#[tauri::command]
pub fn cli_path() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "dawg-cli.exe"
    } else {
        "dawg-cli"
    };
    let p = std::env::current_exe().ok()?.with_file_name(name);
    p.exists().then_some(p)
}

/// The selected clips and ruler range, as an agent's `get_selection` sees
/// them.
#[tauri::command]
pub fn set_selection(state: State<AppState>, clips: Vec<u64>, range: Option<(u64, u64)>) {
    state.lock().selection = Selection { clips, range };
}

#[tauri::command]
pub fn end_gesture(state: State<AppState>) -> Result<SessionState> {
    let mut s = state.lock();
    s.session()?.end_gesture();
    Ok(s.state().expect("session is open"))
}

#[tauri::command]
pub fn undo(state: State<AppState>) -> Result<SessionState> {
    let mut s = state.lock();
    s.session()?.undo();
    s.publish();
    Ok(s.state().expect("session is open"))
}

/// Undoes or redoes to the point where `done` edits are applied.
#[tauri::command]
pub fn jump_history(state: State<AppState>, done: usize) -> Result<SessionState> {
    let mut s = state.lock();
    s.session()?.jump(done);
    s.publish();
    Ok(s.state().expect("session is open"))
}

#[tauri::command]
pub fn redo(state: State<AppState>) -> Result<SessionState> {
    let mut s = state.lock();
    s.session()?.redo();
    s.publish();
    Ok(s.state().expect("session is open"))
}

#[derive(Serialize)]
pub struct ImportResult {
    state: SessionState,
    imported: Imported,
}

/// Adds WAV or MP3 files to the session as clips, in one undo step.
#[tauri::command]
pub fn import_files(
    state: State<AppState>,
    paths: Vec<PathBuf>,
    at: Placement,
) -> Result<ImportResult> {
    let mut s = state.lock();
    let imported = s
        .session()?
        .import(&paths, at)
        .map_err(|e| Error::new("command", e.to_string()))?;
    s.publish();
    Ok(ImportResult {
        state: s.state().expect("session is open"),
        imported,
    })
}

/// `buckets` (min, max) pairs over frames `from..to` of a source, as
/// little-endian `f32`s.
#[tauri::command]
pub fn peaks(
    state: State<AppState>,
    tab: Option<u64>,
    source: u64,
    from: f64,
    to: f64,
    buckets: u32,
) -> Result<tauri::ipc::Response> {
    let s = state.lock();
    let session = s
        .tab_session(tab)
        .ok_or_else(|| Error::new("no_file", "that tab isn't open"))?;
    let (audio, peaks) = session
        .source(source)
        .ok_or_else(|| Error::new("command", format!("no source {source}")))?;
    let buckets = buckets.min(1 << 16) as usize;
    let pairs = peaks.query(audio, from, to.max(from), buckets);
    let mut bytes = Vec::with_capacity(pairs.len() * 8);
    for (lo, hi) in pairs {
        bytes.extend_from_slice(&lo.to_le_bytes());
        bytes.extend_from_slice(&hi.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn play(state: State<AppState>, from: u64, to: u64, looping: Option<u64>) -> Result<()> {
    let mut s = state.lock();
    s.session()?;
    s.audio
        .play(from, to, looping)
        .map_err(|e| Error::new("audio", e))
}

/// Moves the loop or stop point of the playback in progress, without seeking.
#[tauri::command]
pub fn set_bounds(state: State<AppState>, to: u64, looping: Option<u64>) {
    state.lock().audio.set_bounds(to, looping);
}

#[tauri::command]
pub fn stop(state: State<AppState>) {
    state.lock().audio.stop();
}

#[derive(Serialize)]
pub struct Transport {
    playing: bool,
    position: u64,
    /// Peak level (linear, left and right) per track, in track order.
    levels: Vec<[f32; 2]>,
    /// The master output's peak level, after the master volume.
    master: [f32; 2],
}

#[tauri::command]
pub fn transport(state: State<AppState>) -> Transport {
    let (playing, position, levels, master) = state.lock().audio.status();
    Transport {
        playing,
        position,
        levels,
        master,
    }
}

/// The spectrum of `track` after its EQ, from what played since the last
/// call; `None` when nothing new played. `track: null` stops listening.
#[tauri::command]
pub fn spectrum(state: State<AppState>, track: Option<u64>) -> Option<dawg_core::player::Spectrum> {
    state.lock().audio.spectrum(track)
}

#[tauri::command]
pub fn save_preview(state: State<AppState>) -> Result<SavePreview> {
    Ok(state.lock().session()?.preview())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    state: SessionState,
    backup: PathBuf,
}

#[tauri::command]
pub fn replace_original(app: AppHandle, state: State<AppState>) -> Result<ReplaceResult> {
    let dir = backup_dir(&app)?;
    let mut s = state.lock();
    s.audio.stop();
    let r = s
        .session()?
        .replace_original(&dir)
        .map_err(|e| Error::new(e.kind(), e.to_string()))?;
    s.publish();
    Ok(ReplaceResult {
        state: s.state().expect("session is open"),
        backup: r.backup,
    })
}

/// Saves the edit as another file, as WAV or MP3 by its extension (the
/// session's own format when it has neither). Overwriting an existing one
/// (the save dialog has already asked) keeps a backup like Replace does.
#[tauri::command]
pub fn save_as(
    app: AppHandle,
    state: State<AppState>,
    path: PathBuf,
    options: Option<ExportOptions>,
) -> Result<()> {
    let opts = options.unwrap_or_default();
    let mut s = state.lock();
    let session = s.session()?;
    if session::is_project(&path) {
        return Err(Error::new(
            "project_path",
            "that's a project file; export to a .wav or .mp3",
        ));
    }
    if opts.is_default() && session.path().is_some_and(|p| same_file(&path, p)) {
        return Err(Error::new(
            "same_file",
            "that is the file being edited; use Replace original",
        ));
    }
    let codec = Codec::for_path(&path).unwrap_or(session.codec());
    let to_err = |e: dawg_core::session::SessionSaveError| Error::new(e.kind(), e.to_string());
    if path.exists() {
        let bytes = session.render_with(codec, &opts).map_err(to_err)?;
        save::replace(&path, &bytes, &backup_dir(&app)?, None)
            .map_err(|e| Error::new(e.kind(), e.to_string()))?;
        Ok(())
    } else {
        session.export_new(&path, codec, &opts).map_err(to_err)
    }
}

/// Loudest peak of the mixdown over `range` (or every clip heard), in dBFS;
/// `None` when silent.
#[tauri::command]
pub fn mix_peak(state: State<AppState>, range: Option<(u64, u64)>) -> Result<Option<f32>> {
    let mut s = state.lock();
    Ok(s.session()?.mix_peak(range))
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

#[tauri::command]
pub fn last_replace(app: AppHandle) -> Option<Replaced> {
    save::last_replace(&backup_dir(&app).ok()?)
}

/// Puts back the file the last Replace overwrote. Reopens it if it is the
/// one being edited.
#[tauri::command]
pub fn restore_last_replace(
    app: AppHandle,
    state: State<AppState>,
) -> Result<Option<SessionState>> {
    let dir = backup_dir(&app)?;
    let mut s = state.lock();
    s.audio.stop();
    let r = save::restore_last(&dir).map_err(|e| Error::new(e.kind(), e.to_string()))?;
    let reopen = s
        .front()
        .and_then(Session::path)
        .is_some_and(|p| same_file(p, &r.original));
    if reopen {
        let session = Session::open(&r.original).map_err(|e| Error::new("open", e.to_string()))?;
        if let Some(tab) = s.front_tab_mut() {
            tab.slot = Some(session);
            tab.take = None;
        }
        s.publish();
    }
    Ok(s.state())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inner() -> Inner {
        AppState::new(None)
            .inner
            .into_inner()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn edited() -> Session {
        let mut s = Session::new_project();
        s.apply(&Command::AddTrack { name: "a".into() }, false)
            .unwrap();
        s
    }

    #[test]
    fn tabs_open_switch_and_close() {
        let mut s = inner();
        assert!(s.state().is_none());
        // A blank project in front is replaced, not kept.
        s.open_tab(Session::new_project());
        let first = s.active.unwrap();
        s.open_tab(edited());
        assert_eq!(s.tabs.len(), 1);
        assert_eq!(s.active, Some(first));
        // Anything else gets a tab of its own, just after the front one.
        s.open_tab(edited());
        s.open_tab(Session::new_project());
        assert_eq!(s.tabs.len(), 3);
        let ids: Vec<u64> = s.tabs.iter().map(|t| t.id).collect();
        assert_eq!(s.active, Some(ids[2]));
        s.activate(ids[0]);
        s.open_tab(edited());
        let ids: Vec<u64> = s.tabs.iter().map(|t| t.id).collect();
        assert_eq!(s.active, Some(ids[1]));
        assert_eq!(s.tabs.len(), 4);
        // Closing the front tab brings the one to its right forward.
        s.close_tab(ids[1]);
        assert_eq!(s.active, Some(ids[2]));
        // Closing a tab in the back leaves the front alone.
        s.close_tab(ids[0]);
        assert_eq!(s.active, Some(ids[2]));
        s.close_tab(ids[3]);
        s.close_tab(ids[2]);
        assert!(s.active.is_none() && s.tabs.is_empty());
        assert!(s.front_info(false).state.is_none());
    }

    #[test]
    fn takes_the_file_argument() {
        let cwd = std::env::temp_dir();
        let abs = cwd.join("Samples").join("kick 03.wav");
        let args = [OsString::from("--flag"), abs.clone().into()];
        assert_eq!(file_from_args(args.into_iter(), Path::new("x")), Some(abs));
        assert_eq!(file_from_args(std::iter::empty(), &cwd), None);
    }

    #[test]
    fn rejoins_a_file_argument_split_at_spaces() {
        // What the Windows updater's relaunch hands over for
        // `dawg.exe "<dir>\Sph3rical - Wave3.wav"`.
        let dir = std::env::temp_dir().join(format!("dawg-args-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Sph3rical - Wave3.wav");
        std::fs::write(&file, b"").unwrap();
        let split = format!("{}", dir.join("Sph3rical").display());
        let args = [split.as_str(), "-", "Wave3.wav"].map(OsString::from);
        assert_eq!(
            file_from_args(args.into_iter(), Path::new("x")),
            Some(file.clone())
        );
        // A file that really is there isn't joined with what follows.
        let args = [file.as_os_str().to_owned(), OsString::from("extra")];
        assert_eq!(file_from_args(args.into_iter(), Path::new("x")), Some(file));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolves_a_relative_file_against_the_launch_folder() {
        // Unity and shells can pass a path relative to their own folder.
        let cwd = std::env::temp_dir().join("Project");
        let args = ["Assets/Audio/hit.wav"].map(OsString::from);
        assert_eq!(
            file_from_args(args.into_iter(), &cwd),
            Some(cwd.join("Assets/Audio/hit.wav"))
        );
    }
}

/// Shows a file in Explorer, selected.
#[tauri::command]
pub fn reveal_path(path: PathBuf) -> Result<()> {
    #[cfg(windows)]
    let spawned = {
        use std::os::windows::process::CommandExt;
        // `/select,` takes the rest of the argument as the path, quotes and all.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
    };
    #[cfg(not(windows))]
    let spawned = std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(&path))
        .spawn();
    spawned
        .map(|_| ())
        .map_err(|e| Error::new("io", format!("couldn't open the folder: {e}")))
}

fn autosave_dir(app: &AppHandle) -> Result<PathBuf, Error> {
    data_dir(app).map(|d| d.join("autosave"))
}

/// At launch: keeps what an earlier run left unsaved for [`recovery`].
pub fn set_aside_autosave(app: &AppHandle) {
    if let Ok(dir) = autosave_dir(app) {
        autosave::set_aside(&dir);
    }
}

/// Snapshots each tab's unsaved edits for crash recovery (and removes the
/// snapshots of tabs with none). The UI calls it every half minute.
#[tauri::command]
pub fn autosave(app: AppHandle, state: State<AppState>) -> Result<()> {
    let dir = autosave_dir(&app)?;
    let s = state.lock();
    let tabs: Vec<_> = s
        .tabs
        .iter()
        .filter_map(|t| Some((t.id, t.slot.as_ref()?)))
        .collect();
    autosave::write(&dir, &tabs);
    Ok(())
}

/// Removes this run's autosaves: the window is closing on purpose.
#[tauri::command]
pub fn clear_autosave(app: AppHandle) -> Result<()> {
    autosave::clear(&autosave_dir(&app)?);
    Ok(())
}

/// What earlier runs left unsaved.
#[tauri::command]
pub fn recovery(app: AppHandle) -> Result<Vec<autosave::Recovered>> {
    Ok(autosave::recovered(&autosave_dir(&app)?))
}

/// Opens what earlier runs left unsaved, each in a tab of its own. Those
/// that open are forgotten; the first one that fails stops it.
#[tauri::command]
pub fn recover(app: AppHandle, state: State<AppState>, keys: Vec<String>) -> Result<Front> {
    let dir = autosave_dir(&app)?;
    let mut s = state.lock();
    for key in &keys {
        let session = autosave::open(&dir, key).map_err(|e| Error::new(e.kind(), e.to_string()))?;
        autosave::discard(&dir, key);
        s.open_tab(session);
    }
    Ok(s.front_info(false))
}

/// Forgets what earlier runs left unsaved.
#[tauri::command]
pub fn discard_recovery(app: AppHandle) -> Result<()> {
    let dir = autosave_dir(&app)?;
    for r in autosave::recovered(&dir) {
        autosave::discard(&dir, &r.key);
    }
    Ok(())
}
