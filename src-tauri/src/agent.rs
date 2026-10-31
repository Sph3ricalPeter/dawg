//! The coproducer's way in: `dawg-cli mcp` finds this window over a local
//! pipe (per user, never the network) and runs its tools on the open
//! session, so the user sees each edit land and can undo it.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{backup_dir, AppState};

/// Sent to the UI after every agent call.
pub const AGENT_CALL: &str = "agent-call";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Call {
    tool: String,
    /// The session changed, so the UI should fetch it.
    changed: bool,
    /// It was replaced (the agent opened a file or started a project).
    opened: bool,
    error: Option<String>,
}

/// Starts listening, unless another window of this app already is.
pub fn listen(app: &AppHandle) {
    let pipe = dawg_cli::pipe::name(&app.config().identifier);
    let app = app.clone();
    std::thread::spawn(move || {
        let served = dawg_cli::pipe::serve(&pipe, move |tool, args| {
            let backups = backup_dir(&app).map_err(|e| e.message.clone())?;
            let (r, changed) = app.state::<AppState>().agent_call(tool, args, &backups);
            let _ = app.emit(
                AGENT_CALL,
                Call {
                    tool: tool.to_string(),
                    changed: changed.is_some(),
                    opened: changed == Some(true),
                    error: r.as_ref().err().cloned(),
                },
            );
            r
        });
        if let Err(e) = served {
            eprintln!("dawg: no agent pipe {pipe}: {e}");
        }
    });
}
