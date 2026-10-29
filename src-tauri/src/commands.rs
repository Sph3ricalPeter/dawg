//! IPC commands for the editing session. The UI never touches samples: it
//! sends [`Command`]s, gets [`SessionState`] back and asks for peaks.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use dawg_core::file::Codec;
use dawg_core::save::{self, Replaced};
use dawg_core::session::{SavePreview, Session, SessionState};
use dawg_core::Command;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::audio::Audio;

pub struct AppState {
    inner: Mutex<Inner>,
}

struct Inner {
    session: Option<Session>,
    audio: Audio,
    /// The file named on the command line ("Edit in dawg"), until the UI
    /// takes it.
    startup_file: Option<PathBuf>,
}

impl AppState {
    pub fn new(startup_file: Option<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                session: None,
                audio: Audio::default(),
                startup_file,
            }),
        }
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
}

/// The first argument that isn't a flag: Explorer runs `dawg.exe "<file>"`.
pub fn file_from_args(args: impl Iterator<Item = OsString>) -> Option<PathBuf> {
    args.map(PathBuf::from)
        .find(|a| !a.to_string_lossy().starts_with('-'))
}

fn backup_dir(app: &AppHandle) -> Result<PathBuf, Error> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("backups"))
        .map_err(|e| Error::new("io", e.to_string()))
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

#[tauri::command]
pub fn startup_file(state: State<AppState>) -> Option<PathBuf> {
    state.lock().startup_file.take()
}

#[tauri::command]
pub fn open_file(state: State<AppState>, path: PathBuf) -> Result<SessionState> {
    let session = Session::open(&path).map_err(|e| Error::new("open", e.to_string()))?;
    let mut s = state.lock();
    s.audio.stop();
    s.session = Some(session);
    s.publish();
    Ok(s.state().expect("session just opened"))
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

#[tauri::command]
pub fn redo(state: State<AppState>) -> Result<SessionState> {
    let mut s = state.lock();
    s.session()?.redo();
    s.publish();
    Ok(s.state().expect("session is open"))
}

/// `buckets` (min, max) pairs over source frames `from..to`, as little-endian
/// `f32`s.
#[tauri::command]
pub fn peaks(
    state: State<AppState>,
    from: f64,
    to: f64,
    buckets: u32,
) -> Result<tauri::ipc::Response> {
    let mut s = state.lock();
    let session = s.session()?;
    let buckets = buckets.min(1 << 16) as usize;
    let pairs = session
        .peaks()
        .query(session.source(), from, to.max(from), buckets);
    let mut bytes = Vec::with_capacity(pairs.len() * 8);
    for (lo, hi) in pairs {
        bytes.extend_from_slice(&lo.to_le_bytes());
        bytes.extend_from_slice(&hi.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn play(state: State<AppState>, from: u64, to: u64) -> Result<()> {
    let mut s = state.lock();
    s.session()?;
    s.audio.play(from, to).map_err(|e| Error::new("audio", e))
}

#[tauri::command]
pub fn stop(state: State<AppState>) {
    state.lock().audio.stop();
}

#[derive(Serialize)]
pub struct Transport {
    playing: bool,
    position: u64,
}

#[tauri::command]
pub fn transport(state: State<AppState>) -> Transport {
    let (playing, position) = state.lock().audio.status();
    Transport { playing, position }
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
pub fn save_as(app: AppHandle, state: State<AppState>, path: PathBuf) -> Result<()> {
    let mut s = state.lock();
    let session = s.session()?;
    if same_file(&path, session.path()) {
        return Err(Error::new(
            "same_file",
            "that is the file being edited; use Replace original",
        ));
    }
    let codec = Codec::for_path(&path).unwrap_or(session.codec());
    let to_err = |e: dawg_core::session::SessionSaveError| Error::new(e.kind(), e.to_string());
    if path.exists() {
        let bytes = session
            .render_file(codec)
            .map_err(|e| Error::new("format", e.to_string()))?;
        save::replace(&path, &bytes, &backup_dir(&app)?, None)
            .map_err(|e| Error::new(e.kind(), e.to_string()))?;
        Ok(())
    } else {
        session.save_as_new(&path, codec).map_err(to_err)
    }
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
        .is_some_and(|x| same_file(x.path(), &r.original));
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
        let args = ["--flag", r"C:\Samples\kick 03.wav"].map(OsString::from);
        assert_eq!(
            file_from_args(args.into_iter()),
            Some(PathBuf::from(r"C:\Samples\kick 03.wav"))
        );
        assert_eq!(file_from_args(std::iter::empty()), None);
    }
}
