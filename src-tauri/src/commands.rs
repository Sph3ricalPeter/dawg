//! IPC commands for the editing session. The UI never touches samples: it
//! sends [`Command`]s, gets [`SessionState`] back and asks for peaks.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use dawg_core::file::Codec;
use dawg_core::save::{self, Replaced};
use dawg_core::session::{
    self, ExportOptions, Imported, Placement, SavePreview, Session, SessionState,
};
use dawg_core::Command;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::audio::Audio;
use crate::recent::{self, Recent};

pub struct AppState {
    inner: Mutex<Inner>,
}

struct Inner {
    session: Option<Session>,
    audio: Audio,
    /// A file named on the command line ("Edit in dawg", Unity's external
    /// editor), or handed over by a second launch, until the UI takes it.
    pending_file: Option<PathBuf>,
}

impl AppState {
    pub fn new(startup_file: Option<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                session: None,
                audio: Audio::default(),
                pending_file: startup_file,
            }),
        }
    }

    /// Queues a file for the UI to open (see [`startup_file`]).
    pub fn request_open(&self, path: PathBuf) {
        self.lock().pending_file = Some(path);
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic mid-command leaves nothing half-applied worth refusing.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Inner {
    fn session(&mut self) -> Result<&mut Session, Error> {
        self.session
            .as_mut()
            .ok_or_else(|| Error::new("no_file", "no file is open"))
    }

    /// Hands the current snapshot to the player after an edit.
    fn publish(&mut self) {
        if let Some(s) = &self.session {
            let p = s.project().clone();
            self.audio.set_project(p);
        }
    }

    fn state(&self) -> Option<SessionState> {
        self.session.as_ref().map(Session::state)
    }

    fn replace_session(&mut self, session: Session) -> SessionState {
        self.audio.stop();
        self.session = Some(session);
        self.publish();
        self.state().expect("session just set")
    }
}

/// The first argument that isn't a flag: Explorer runs `dawg.exe "<file>"`.
/// A relative path is taken from `cwd`, the launching process's folder.
pub fn file_from_args(args: impl Iterator<Item = OsString>, cwd: &Path) -> Option<PathBuf> {
    args.map(PathBuf::from)
        .find(|a| !a.to_string_lossy().starts_with('-'))
        .map(|p| cwd.join(p))
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, Error> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| Error::new("io", e.to_string()))
}

fn backup_dir(app: &AppHandle) -> Result<PathBuf, Error> {
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
    message: String,
}

impl Error {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

type Result<T, E = Error> = std::result::Result<T, E>;

/// The file waiting to be opened, if any. The UI asks once on load and again
/// whenever the backend emits [`OPEN_REQUESTED`].
#[tauri::command]
pub fn startup_file(state: State<AppState>) -> Option<PathBuf> {
    state.lock().pending_file.take()
}

/// Emitted when a second launch handed this window a file.
pub const OPEN_REQUESTED: &str = "open-requested";

/// Opens a WAV or MP3 as a scratch session, or a `.dawg` project.
#[tauri::command]
pub fn open_file(app: AppHandle, state: State<AppState>, path: PathBuf) -> Result<SessionState> {
    let session = if session::is_project(&path) {
        let s = Session::open_project(&path).map_err(|e| Error::new(e.kind(), e.to_string()))?;
        remember(&app, &path);
        s
    } else {
        Session::open(&path).map_err(|e| Error::new("open", e.to_string()))?
    };
    Ok(state.lock().replace_session(session))
}

#[tauri::command]
pub fn new_project(state: State<AppState>) -> SessionState {
    state.lock().replace_session(Session::new_project())
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
    source: u64,
    from: f64,
    to: f64,
    buckets: u32,
) -> Result<tauri::ipc::Response> {
    let mut s = state.lock();
    let session = s.session()?;
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
        .session
        .as_ref()
        .and_then(Session::path)
        .is_some_and(|p| same_file(p, &r.original));
    if reopen {
        let session = Session::open(&r.original).map_err(|e| Error::new("open", e.to_string()))?;
        s.session = Some(session);
        s.publish();
    }
    Ok(s.state())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_file_argument() {
        let cwd = std::env::temp_dir();
        let abs = cwd.join("Samples").join("kick 03.wav");
        let args = [OsString::from("--flag"), abs.clone().into()];
        assert_eq!(file_from_args(args.into_iter(), Path::new("x")), Some(abs));
        assert_eq!(file_from_args(std::iter::empty(), &cwd), None);
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
