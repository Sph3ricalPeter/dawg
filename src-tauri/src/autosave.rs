//! Autosave and crash recovery. While a tab has unsaved edits, the UI asks
//! every half minute for a snapshot of it in the data folder
//! (`autosave/tab-<id>.dawg` plus a small JSON note of what it was). Saving,
//! closing the tab or closing the window on purpose removes it. At launch,
//! snapshots left behind are renamed `recovered-*`, so this run's autosaves
//! can't overwrite them before the user decides.
//!
//! Everything stays in one folder: a snapshot stores its audio files'
//! paths relative to where it was written as well as absolute.

use std::fs;
use std::path::{Path, PathBuf};

use dawg_core::Session;
use serde::{Deserialize, Serialize};

/// This run's snapshots: `tab-<id>.dawg` and `tab-<id>.json`.
const TAB: &str = "tab-";
/// What earlier runs left: `recovered-<stamp>-<what it was>`.
const RECOVERED: &str = "recovered-";
/// Before tabs: one session's snapshot, and one set aside for recovery.
const LEGACY: &[&str] = &["session", "recovered"];

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

/// An unsaved session an earlier run left behind.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovered {
    /// Names it for [`open`] and [`discard`].
    pub key: String,
    #[serde(flatten)]
    pub note: Note,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn tab_stem(id: u64) -> String {
    format!("{TAB}{id}")
}

/// Writes a snapshot of each tab with unsaved edits and removes this run's
/// other snapshots (tabs saved or closed since). Best effort.
pub fn write(dir: &Path, tabs: &[(u64, &Session)]) {
    let mut keep = Vec::new();
    for (id, session) in tabs {
        if !session.dirty() {
            continue;
        }
        let stem = tab_stem(*id);
        if fs::create_dir_all(dir).is_err() {
            return;
        }
        let state = session.state();
        let note = Note {
            name: state.name,
            project: state.project,
            saved_at: now_ms(),
        };
        let snap = dir.join(format!("{stem}.dawg"));
        // The snapshot first, then the note that says it is complete.
        let tmp = dir.join(format!("{stem}.dawg.tmp"));
        if fs::write(&tmp, session.snapshot(&snap)).is_ok() && fs::rename(&tmp, &snap).is_ok() {
            if let Ok(json) = serde_json::to_vec(&note) {
                let _ = fs::write(dir.join(format!("{stem}.json")), json);
            }
        }
        keep.push(stem);
    }
    remove_tabs(dir, |stem| !keep.iter().any(|k| k == stem));
}

/// Removes this run's snapshots: the window is closing on purpose.
pub fn clear(dir: &Path) {
    remove_tabs(dir, |_| true);
}

/// Removes this run's snapshot files whose stem `drop` picks.
fn remove_tabs(dir: &Path, drop: impl Fn(&str) -> bool) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.starts_with(TAB) {
            continue;
        }
        let stem = name.split('.').next().unwrap_or_default();
        if drop(stem) {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// At launch: sets aside what the last run left unsaved (and anything
/// still waiting from before), and removes half-written leftovers.
pub fn set_aside(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let stamp = now_ms();
    for name in &names {
        let Some(stem) = name.strip_suffix(".dawg") else {
            continue;
        };
        let ours = stem.starts_with(TAB) || LEGACY.contains(&stem);
        if !ours {
            continue;
        }
        let note = dir.join(format!("{stem}.json"));
        if note.exists() {
            let to = format!("{RECOVERED}{stamp}-{stem}");
            let _ = fs::rename(dir.join(name), dir.join(format!("{to}.dawg")));
            let _ = fs::rename(note, dir.join(format!("{to}.json")));
        }
    }
    // Snapshots that never got their note, and notes without a snapshot.
    for name in &names {
        let stem = name.split('.').next().unwrap_or_default();
        let ours = stem.starts_with(TAB) || LEGACY.contains(&stem);
        if ours && dir.join(name).exists() {
            let _ = fs::remove_file(dir.join(name));
        }
    }
}

/// The unsaved sessions earlier runs left behind, oldest first.
pub fn recovered(dir: &Path) -> Vec<Recovered> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<Recovered> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let key = name
                .strip_suffix(".json")?
                .strip_prefix(RECOVERED)?
                .to_string();
            if !dir.join(format!("{RECOVERED}{key}.dawg")).exists() {
                return None;
            }
            let note: Note = serde_json::from_slice(&fs::read(e.path()).ok()?).ok()?;
            Some(Recovered { key, note })
        })
        .collect();
    out.sort_by_key(|r| r.note.saved_at);
    out
}

fn safe_key(key: &str) -> bool {
    !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Opens one recovered session; its files stay until [`discard`].
pub fn open(dir: &Path, key: &str) -> Result<Session, dawg_core::project_file::ProjectError> {
    let snap = dir.join(format!("{RECOVERED}{key}.dawg"));
    if !safe_key(key) {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no such autosave").into());
    }
    let note: Option<Note> = fs::read(dir.join(format!("{RECOVERED}{key}.json")))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    Session::recover(&snap, note.as_ref().and_then(|n| n.project.as_deref()))
}

/// Forgets one recovered session.
pub fn discard(dir: &Path, key: &str) {
    if !safe_key(key) {
        return;
    }
    let _ = fs::remove_file(dir.join(format!("{RECOVERED}{key}.json")));
    let _ = fs::remove_file(dir.join(format!("{RECOVERED}{key}.dawg")));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(name: &str) -> Vec<u8> {
        serde_json::to_vec(&Note {
            name: name.into(),
            project: None,
            saved_at: 1,
        })
        .unwrap()
    }

    #[test]
    fn left_behind_autosaves_are_set_aside() {
        let dir = std::env::temp_dir().join(format!("dawg-autosave-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(recovered(&dir).is_empty());
        // Clean tabs leave nothing.
        let clean = Session::new_project();
        write(&dir, &[(1, &clean)]);
        assert!(fs::read_dir(&dir).unwrap().next().is_none());
        // Two tabs from a run that crashed, a pre-tabs snapshot, and a
        // half-written one.
        let raw = Session::new_project().snapshot(&dir.join("x.dawg"));
        for stem in ["tab-1", "tab-4", "session"] {
            fs::write(dir.join(format!("{stem}.dawg")), &raw).unwrap();
        }
        fs::write(dir.join("tab-1.json"), note("song.dawg")).unwrap();
        fs::write(dir.join("tab-4.json"), note("kick.wav")).unwrap();
        fs::write(dir.join("session.json"), note("old.dawg")).unwrap();
        fs::write(dir.join("tab-9.dawg"), &raw).unwrap();
        set_aside(&dir);
        let r = recovered(&dir);
        let mut names: Vec<_> = r.iter().map(|r| r.note.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["kick.wav", "old.dawg", "song.dawg"]);
        assert!(!dir.join("tab-9.dawg").exists());
        // This run's autosaves don't touch them.
        clear(&dir);
        assert_eq!(recovered(&dir).len(), 3);
        let key = r[0].key.clone();
        assert!(open(&dir, &key).is_ok());
        assert!(open(&dir, "../x").is_err());
        discard(&dir, &key);
        assert_eq!(recovered(&dir).len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
