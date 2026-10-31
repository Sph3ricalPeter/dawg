//! `dawg-cli` as a library: the MCP tools, the server, and the pipe the app
//! listens on so an agent can work in the open window.

pub mod mcp;
pub mod pipe;
pub mod png;
pub mod tools;

use std::path::{Path, PathBuf};

use dawg_core::session::{is_project, Session};

/// Opens an audio file as a scratch session, or a `.dawg` project.
pub fn open(path: &Path) -> Result<Session, String> {
    if is_project(path) {
        Session::open_project(path).map_err(|e| format!("{}: {e}", path.display()))
    } else {
        Session::open(path).map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// Where replaced files' backups go: the app's own folder, so the app's
/// "restore" and its pruning see them too. `DAWG_BACKUPS` overrides it.
pub fn backup_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("DAWG_BACKUPS") {
        return PathBuf::from(d);
    }
    let env = |k| std::env::var_os(k).map(PathBuf::from);
    let base = if cfg!(windows) {
        env("LOCALAPPDATA")
    } else if cfg!(target_os = "macos") {
        env("HOME").map(|h| h.join("Library/Application Support"))
    } else {
        env("XDG_DATA_HOME").or_else(|| env("HOME").map(|h| h.join(".local/share")))
    };
    base.unwrap_or_else(std::env::temp_dir)
        .join(pipe::APP_IDS[0])
        .join("backups")
}

/// Seconds to timeline frames.
pub fn frames(seconds: f64, rate: u32) -> u64 {
    (seconds.max(0.0) * rate as f64).round() as u64
}
