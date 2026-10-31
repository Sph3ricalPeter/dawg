//! Autosave and crash recovery. While the session has unsaved edits, the UI
//! asks every half minute for a snapshot in the data folder
//! (`autosave/session.dawg` plus a small JSON note of what it was). Saving,
//! exporting, opening something else or closing normally removes it. At
//! launch a snapshot left behind is moved aside to `recovered.*`, so the new
//! session's autosaves can't overwrite it before the user decides.

use std::fs;
use std::path::{Path, PathBuf};

use dawg_core::Session;
use serde::{Deserialize, Serialize};

const SNAPSHOT: &str = "session.dawg";
const NOTE: &str = "session.json";
const RECOVERED: &str = "recovered.dawg";
const RECOVERED_NOTE: &str = "recovered.json";

/// What an autosave was of.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// The session's name ("kick.wav", "song.dawg", "Untitled").
    pub name: String,
    /// The project file it belongs to, when it was a saved project.
    pub project: Option<PathBuf>,
    /// When it was written, in ms since the Unix epoch.
    pub saved_at: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Writes a snapshot of `session`, or removes the last one when it has no
/// unsaved edits. Best effort.
pub fn write(dir: &Path, session: &Session) {
    if !session.dirty() {
        clear(dir);
        return;
    }
    let state = session.state();
    let note = Note {
        name: state.name,
        project: state.project,
        saved_at: now_ms(),
    };
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let snap = dir.join(SNAPSHOT);
    // The snapshot first, then the note that says it is complete.
    let tmp = dir.join("session.dawg.tmp");
    if fs::write(&tmp, session.snapshot(&snap)).is_ok() && fs::rename(&tmp, &snap).is_ok() {
        if let Ok(json) = serde_json::to_vec(&note) {
            let _ = fs::write(dir.join(NOTE), json);
        }
    }
}

/// Removes the current session's autosave.
pub fn clear(dir: &Path) {
    let _ = fs::remove_file(dir.join(NOTE));
    let _ = fs::remove_file(dir.join(SNAPSHOT));
}

/// At launch: moves what the last run left behind aside for recovery.
pub fn set_aside(dir: &Path) {
    if dir.join(NOTE).exists() && dir.join(SNAPSHOT).exists() {
        let _ = fs::rename(dir.join(SNAPSHOT), dir.join(RECOVERED));
        let _ = fs::rename(dir.join(NOTE), dir.join(RECOVERED_NOTE));
    } else {
        clear(dir);
    }
}

/// The unsaved session the last run left behind, if any.
pub fn recovered(dir: &Path) -> Option<Note> {
    if !dir.join(RECOVERED).exists() {
        return None;
    }
    serde_json::from_slice(&fs::read(dir.join(RECOVERED_NOTE)).ok()?).ok()
}

/// Opens the recovered session; the files stay until [`discard`].
pub fn open(dir: &Path) -> Result<Session, dawg_core::project_file::ProjectError> {
    let note = recovered(dir);
    Session::recover(
        &dir.join(RECOVERED),
        note.as_ref().and_then(|n| n.project.as_deref()),
    )
}

/// Forgets the recovered session.
pub fn discard(dir: &Path) {
    let _ = fs::remove_file(dir.join(RECOVERED_NOTE));
    let _ = fs::remove_file(dir.join(RECOVERED));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_left_behind_autosave_is_set_aside() {
        let dir = std::env::temp_dir().join(format!("dawg-autosave-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(recovered(&dir).is_none());
        // A clean session leaves nothing.
        write(&dir, &Session::new_project());
        assert!(!dir.join(SNAPSHOT).exists());
        fs::write(dir.join(SNAPSHOT), b"{}").unwrap();
        let note = Note {
            name: "song.dawg".into(),
            project: None,
            saved_at: 1,
        };
        fs::write(dir.join(NOTE), serde_json::to_vec(&note).unwrap()).unwrap();
        set_aside(&dir);
        assert!(!dir.join(SNAPSHOT).exists());
        assert_eq!(recovered(&dir).unwrap().name, "song.dawg");
        discard(&dir);
        assert!(recovered(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
