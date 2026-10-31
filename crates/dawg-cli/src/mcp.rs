//! The MCP server: JSON-RPC 2.0 over stdin/stdout, one message per line.
//! It holds one session (an audio file or a project) that the agent opens,
//! edits with the same commands the app uses, listens to through numbers
//! (analysis) and pictures (waveforms), and saves. Each `apply` is one undo
//! step named "AI: ...", so the edit history says what the agent did.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use dawg_core::session::Session;
use serde_json::{json, Value};

use crate::tools::{self, text, Ctx, Tools};
use crate::{backup_dir, pipe};

const PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "\
dawg is a DAW for quick sound design. When the dawg window is open, the \
tools work on its session and the user watches each edit land (get_project \
says attached: true, and get_selection tells you what \"this\" means); \
otherwise open a WAV/MP3 (a scratch session that edits the file) or a .dawg \
project, or start a new project and import files. get_project shows tracks \
and clips by stable id; positions and lengths are frames at the session's \
sample rate (`rate`). Edit with apply, a list of commands that land as one \
undo step named after your label. Check your work with analyze (peak, \
loudness, onsets, brightness) and render_image (a waveform picture) before \
saving. Nothing touches disk until save_original, save_project or export; \
writing over an existing file keeps a backup.";

/// Serves until stdin closes.
pub fn serve() -> Result<(), String> {
    let mut server = Server::new(true);
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = server.handle(&line) {
            writeln!(out, "{reply}").map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub struct Server {
    /// The headless session, while the app isn't open.
    session: Option<Session>,
    /// Look for the open app before each call.
    attach: bool,
    backups: PathBuf,
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

impl Server {
    pub fn new(attach: bool) -> Server {
        Server {
            session: None,
            attach,
            backups: backup_dir(),
        }
    }

    /// One incoming line; the reply, unless it was a notification.
    pub fn handle(&mut self, line: &str) -> Option<Value> {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => return Some(rpc_error(Value::Null, -32700, &e.to_string())),
        };
        let id = msg.get("id").cloned()?;
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        let result = match method {
            "initialize" => {
                let asked = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let version = PROTOCOLS
                    .iter()
                    .find(|v| **v == asked)
                    .unwrap_or(&PROTOCOLS[0]);
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "dawg", "version": dawg_core::VERSION },
                    "instructions": INSTRUCTIONS,
                })
            }
            "ping" => json!({}),
            "tools/list" => json!({ "tools": tools::list() }),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                let app = if self.attach {
                    pipe::call_app(name, &args)
                } else {
                    None
                };
                let r = app.unwrap_or_else(|| {
                    Tools {
                        slot: &mut self.session,
                        ctx: Ctx {
                            backups: &self.backups,
                            attached: false,
                            selection: None,
                        },
                    }
                    .call(name, &args)
                });
                result(r)
            }
            _ => return Some(rpc_error(id, -32601, &format!("no method {method}"))),
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }
}

/// A tool's outcome as an MCP `tools/call` result.
pub fn result(r: Result<Vec<Value>, String>) -> Value {
    match r {
        Ok(content) => json!({ "content": content, "isError": false }),
        Err(e) => json!({ "content": [text(&e)], "isError": true }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::base64;

    fn call(s: &mut Server, id: u64, method: &str, params: Value) -> Value {
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        s.handle(&line.to_string()).expect("a reply")
    }

    fn tool(s: &mut Server, name: &str, args: Value) -> Value {
        call(
            s,
            9,
            "tools/call",
            json!({ "name": name, "arguments": args }),
        )["result"]
            .clone()
    }

    /// A short stereo WAV of integer-made noise bursts.
    fn wav(dir: &std::path::Path, name: &str) -> PathBuf {
        let rate = 48_000u32;
        let frames = rate as usize / 2;
        let mut data = Vec::new();
        let mut x: u32 = 1;
        for i in 0..frames {
            x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let on = (i / 4800) % 2 == 0;
            let v = if on { ((x >> 16) as i16) / 4 } else { 0 };
            for _ in 0..2 {
                data.extend_from_slice(&v.to_le_bytes());
            }
        }
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * 4).to_le_bytes());
        b.extend_from_slice(&4u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(data.len() as u32).to_le_bytes());
        b.extend_from_slice(&data);
        let p = dir.join(name);
        std::fs::write(&p, b).unwrap();
        p
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dawg-cli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn base64_matches_the_rfc() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn handshake_and_tools() {
        let mut s = Server::new(false);
        let r = call(
            &mut s,
            1,
            "initialize",
            json!({ "protocolVersion": "2025-03-26" }),
        );
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert!(s
            .handle(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .is_none());
        let r = call(&mut s, 2, "tools/list", json!({}));
        let names: Vec<&str> = r["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"apply") && names.contains(&"render_image"));
        assert_eq!(call(&mut s, 3, "nope", json!({}))["error"]["code"], -32601);
        assert_eq!(tool(&mut s, "get_project", json!({}))["isError"], true);
    }

    #[test]
    fn an_agent_builds_checks_and_exports_a_project() {
        let dir = tmp("agent");
        let a = wav(&dir, "hit.wav");
        let mut s = Server::new(false);
        tool(&mut s, "new_project", json!({}));
        let r = tool(&mut s, "import_files", json!({ "paths": [a, a] }));
        assert_eq!(r["isError"], false, "{r}");
        let st = s.session.as_ref().unwrap().state();
        assert_eq!(st.tracks.len(), 2);
        let (t2, clip) = (st.tracks[1].id, st.tracks[1].clips[0].id);

        let r = tool(
            &mut s,
            "apply",
            json!({
                "label": "push second hit later",
                "commands": [
                    { "type": "move_clip", "clip": clip, "track": t2, "start": 24_000 },
                    { "type": "set_track_mix", "track": t2, "gain_db": -6.0 }
                ]
            }),
        );
        assert_eq!(r["isError"], false, "{r}");
        let st = s.session.as_ref().unwrap().state();
        assert_eq!(
            st.history.last().unwrap().label,
            "AI: push second hit later"
        );
        assert_eq!(st.end, 48_000);

        // A bad command leaves the session as it was.
        let r = tool(
            &mut s,
            "apply",
            json!({ "label": "x", "commands": [{ "type": "delete_clip", "clip": 999 }] }),
        );
        assert_eq!(r["isError"], true);
        assert_eq!(s.session.as_ref().unwrap().state().history.len(), 2);

        let r = tool(&mut s, "analyze", json!({ "track": t2 }));
        let x: Value = serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(x["peakDb"].as_f64().unwrap() < 0.0);
        assert!((x["seconds"].as_f64().unwrap() - 0.5).abs() < 1e-6);

        let r = tool(&mut s, "render_image", json!({ "width": 200 }));
        assert_eq!(r["content"][0]["mimeType"], "image/png");
        assert!(r["content"][0]["data"]
            .as_str()
            .unwrap()
            .starts_with("iVBORw0KGgo"));

        let out = dir.join("mix.wav");
        let r = tool(&mut s, "export", json!({ "path": out, "bits": 16 }));
        assert_eq!(r["isError"], false, "{r}");
        let first = std::fs::read(&out).unwrap();
        // An existing file is only replaced when asked, and keeps a backup.
        s.backups = dir.join("backups");
        assert_eq!(
            tool(&mut s, "export", json!({ "path": out }))["isError"],
            true
        );
        let r = tool(
            &mut s,
            "export",
            json!({ "path": out, "overwrite": true, "bits": 24 }),
        );
        assert_eq!(r["isError"], false, "{r}");
        assert_ne!(std::fs::read(&out).unwrap(), first);
        assert!(std::fs::read_dir(dir.join("backups")).unwrap().count() > 0);

        let project = dir.join("song.dawg");
        assert_eq!(tool(&mut s, "save_project", json!({}))["isError"], true);
        assert_eq!(
            tool(&mut s, "save_project", json!({ "path": project }))["isError"],
            false
        );
        assert_eq!(tool(&mut s, "undo", json!({}))["isError"], false);
        tool(&mut s, "open", json!({ "path": project }));
        assert_eq!(s.session.as_ref().unwrap().state().end, 48_000);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
