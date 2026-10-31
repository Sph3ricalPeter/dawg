//! The MCP server: JSON-RPC 2.0 over stdin/stdout, one message per line.
//! It holds one session (an audio file or a project) that the agent opens,
//! edits with the same commands the app uses, listens to through numbers
//! (analysis) and pictures (waveforms), and saves. Each `apply` is one undo
//! step named "AI: ...", so the edit history says what the agent did.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use dawg_core::file::Codec;
use dawg_core::session::{is_project, ExportOptions, Placement, Session};
use dawg_core::{save, Command};
use serde_json::{json, Value};

use crate::{backup_dir, frames, open, png};

const PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "\
dawg is a DAW for quick sound design. Open a WAV/MP3 (a scratch session that \
edits the file) or a .dawg project, or start a new project and import files. \
get_project shows tracks and clips by stable id; positions and lengths are \
frames at the session's sample rate (`rate`). Edit with apply, a list of \
commands that land as one undo step. Check your work with analyze (peak, \
loudness, onsets, brightness) and render_image (a waveform picture) before \
saving. Nothing touches disk until save_original, save_project or export; \
writing over an existing file keeps a backup.";

/// Serves until stdin closes.
pub fn serve() -> Result<(), String> {
    let mut server = Server { session: None };
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
    session: Option<Session>,
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

impl Server {
    #[cfg(test)]
    fn new() -> Server {
        Server { session: None }
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
            "tools/list" => json!({ "tools": tools() }),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                match self.call(name, &args) {
                    Ok(content) => json!({ "content": content, "isError": false }),
                    Err(e) => json!({ "content": [text(&e)], "isError": true }),
                }
            }
            _ => return Some(rpc_error(id, -32601, &format!("no method {method}"))),
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    fn session(&mut self) -> Result<&mut Session, String> {
        self.session
            .as_mut()
            .ok_or_else(|| "nothing is open: call open or new_project first".to_string())
    }

    fn call(&mut self, name: &str, a: &Value) -> Result<Vec<Value>, String> {
        match name {
            "open" => {
                let path = PathBuf::from(str_arg(a, "path")?);
                self.session = Some(open(&path)?);
                self.state()
            }
            "new_project" => {
                self.session = Some(Session::new_project());
                self.state()
            }
            "get_project" => self.state(),
            "import_files" => {
                let paths: Vec<PathBuf> = a
                    .get("paths")
                    .and_then(Value::as_array)
                    .ok_or("paths must be a list of file paths")?
                    .iter()
                    .filter_map(Value::as_str)
                    .map(PathBuf::from)
                    .collect();
                let s = self.session()?;
                let rate = s.state().rate;
                let at = Placement {
                    track: a.get("track").and_then(Value::as_u64),
                    start: frames(num(a, "start").unwrap_or(0.0), rate),
                };
                let r = s.import(&paths, at).map_err(|e| e.to_string())?;
                let mut out = vec![text(&json!(r).to_string())];
                out.extend(self.state()?);
                Ok(out)
            }
            "apply" => {
                let commands: Vec<Command> = serde_json::from_value(
                    a.get("commands").cloned().ok_or("commands is required")?,
                )
                .map_err(|e| format!("commands: {e}"))?;
                let label = a
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|l| !l.trim().is_empty())
                    .unwrap_or("edit");
                let batch = Command::Batch {
                    commands,
                    label: Some(format!("AI: {}", label.trim())),
                };
                self.session()?
                    .apply(&batch, false)
                    .map_err(|e| e.to_string())?;
                self.state()
            }
            "undo" | "redo" => {
                let s = self.session()?;
                let done = if name == "undo" { s.undo() } else { s.redo() };
                if !done {
                    return Err(format!("nothing to {name}"));
                }
                self.state()
            }
            "analyze" => {
                let (range, track, clip) = self.part(a)?;
                let x = self
                    .session()?
                    .analyze(range, track, clip)
                    .map_err(|e| e.to_string())?;
                Ok(vec![text(&serde_json::to_string(&x).unwrap_or_default())])
            }
            "render_image" => {
                let (range, track, clip) = self.part(a)?;
                let width = a
                    .get("width")
                    .and_then(Value::as_u64)
                    .unwrap_or(1000)
                    .clamp(64, 4000) as usize;
                let png = picture(self.session()?, range, track, clip, width)?;
                Ok(vec![json!({
                    "type": "image",
                    "data": base64(&png),
                    "mimeType": "image/png",
                })])
            }
            "export" => {
                let path = PathBuf::from(str_arg(a, "path")?);
                let codec = Codec::for_path(&path).ok_or("path must end in .wav or .mp3")?;
                let (range, _, _) = self.part(a)?;
                let opts = ExportOptions {
                    range,
                    bits: a.get("bits").and_then(Value::as_u64).map(|v| v as u16),
                    rate: a.get("rate").and_then(Value::as_u64).map(|v| v as u32),
                    kbps: a.get("kbps").and_then(Value::as_u64).map(|v| v as u32),
                };
                let s = self.session()?;
                if path.exists() {
                    if a.get("overwrite").and_then(Value::as_bool) != Some(true) {
                        return Err(format!(
                            "{} exists; pass overwrite: true to replace it (a backup is kept)",
                            path.display()
                        ));
                    }
                    let bytes = s.render_with(codec, &opts).map_err(|e| e.to_string())?;
                    let r = save::replace(&path, &bytes, &backup_dir(), None)
                        .map_err(|e| e.to_string())?;
                    return Ok(vec![text(&format!(
                        "replaced {} (backup: {})",
                        path.display(),
                        r.backup.display()
                    ))]);
                }
                s.export_new(&path, codec, &opts)
                    .map_err(|e| e.to_string())?;
                Ok(vec![text(&format!("wrote {}", path.display()))])
            }
            "save_original" => {
                let s = self.session()?;
                if !s.state().scratch {
                    return Err("this is a project: use save_project or export".into());
                }
                let r = s
                    .replace_original(&backup_dir())
                    .map_err(|e| e.to_string())?;
                Ok(vec![text(&format!(
                    "saved {} (backup: {})",
                    r.original.display(),
                    r.backup.display()
                ))])
            }
            "save_project" => {
                let s = self.session()?;
                let path = match a.get("path").and_then(Value::as_str) {
                    Some(p) => PathBuf::from(p),
                    None => s
                        .project_path()
                        .ok_or("the project has never been saved: give a path ending in .dawg")?
                        .to_path_buf(),
                };
                if !is_project(&path) {
                    return Err("a project path must end in .dawg".into());
                }
                s.save_project(&path).map_err(|e| e.to_string())?;
                Ok(vec![text(&format!("saved {}", path.display()))])
            }
            _ => Err(format!("no tool {name}")),
        }
    }

    fn state(&mut self) -> Result<Vec<Value>, String> {
        let s = self.session()?;
        Ok(vec![text(&summary(s).to_string())])
    }

    /// `from`/`to` (seconds), `track` and `clip` from tool arguments.
    #[allow(clippy::type_complexity)]
    fn part(
        &mut self,
        a: &Value,
    ) -> Result<(Option<(u64, u64)>, Option<u64>, Option<u64>), String> {
        let st = self.session()?.state();
        let (from, to) = (num(a, "from"), num(a, "to"));
        let range = if from.is_none() && to.is_none() {
            None
        } else {
            let x = from.map_or(st.start, |f| frames(f, st.rate));
            let y = to.map_or(st.end, |t| frames(t, st.rate));
            if y <= x {
                return Err("to must be after from".into());
            }
            Some((x, y))
        };
        Ok((
            range,
            a.get("track").and_then(Value::as_u64),
            a.get("clip").and_then(Value::as_u64),
        ))
    }
}

fn text(s: &str) -> Value {
    json!({ "type": "text", "text": s })
}

fn str_arg<'a>(a: &'a Value, k: &str) -> Result<&'a str, String> {
    a.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{k} is required"))
}

fn num(a: &Value, k: &str) -> Option<f64> {
    a.get(k).and_then(Value::as_f64)
}

/// The session as an agent reads it: the app's state, with lengths in
/// seconds alongside the frames.
pub fn summary(s: &Session) -> Value {
    let st = s.state();
    let rate = st.rate as f64;
    let mut v = serde_json::to_value(&st).unwrap_or_default();
    if let Some(o) = v.as_object_mut() {
        o.insert("startSeconds".into(), json!(st.start as f64 / rate));
        o.insert("endSeconds".into(), json!(st.end as f64 / rate));
        o.remove("canUndo");
        o.remove("canRedo");
    }
    v
}

/// The clip palette, as the app colours tracks.
const COLORS: [[u8; 3]; 8] = [
    [0xee, 0x9f, 0x98],
    [0xf5, 0xc5, 0x5c],
    [0xc3, 0xdd, 0x76],
    [0x7d, 0xd6, 0xc4],
    [0x9e, 0xc8, 0xea],
    [0xf0, 0xa8, 0xcf],
    [0xb9, 0xc2, 0xcf],
    [0xdc, 0xc8, 0x9f],
];

/// A waveform PNG: one lane per track (or just the track or clip asked
/// for), over the same span so lanes line up.
pub fn picture(
    s: &Session,
    range: Option<(u64, u64)>,
    track: Option<u64>,
    clip: Option<u64>,
    width: usize,
) -> Result<Vec<u8>, String> {
    let st = s.state();
    let color = |i: usize| {
        let t = &st.tracks[i];
        COLORS[t.color.map_or(i, usize::from) % COLORS.len()]
    };
    let index = |id: u64| st.tracks.iter().position(|t| t.id == id);
    let mut lanes: Vec<(Vec<f32>, [u8; 3])> = Vec::new();
    if track.is_some() || clip.is_some() || st.tracks.len() <= 1 {
        let (_, samples) = s
            .render_part(range, track, clip)
            .map_err(|e| e.to_string())?;
        let i = match (clip, track) {
            (Some(c), _) => st
                .tracks
                .iter()
                .position(|t| t.clips.iter().any(|x| x.id == c)),
            (None, Some(t)) => index(t),
            _ => Some(0),
        };
        lanes.push((samples, i.map_or(COLORS[0], color)));
    } else {
        let span = match range {
            Some(r) => r,
            None if st.end > st.start => (st.start, st.end),
            None => return Err("there's nothing to hear".into()),
        };
        for (i, t) in st.tracks.iter().enumerate() {
            let (_, samples) = s
                .render_part(Some(span), Some(t.id), None)
                .map_err(|e| e.to_string())?;
            lanes.push((samples, color(i)));
        }
    }
    let lane_h = (480 / lanes.len()).clamp(60, 160);
    let refs: Vec<(&[f32], [u8; 3])> = lanes.iter().map(|(s, c)| (s.as_slice(), *c)).collect();
    Ok(png::waveform(&refs, st.rate, width, lane_h).png())
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

const COMMANDS: &str = "\
Each command is an object with a \"type\". Ids come from get_project; \
frames are at the session's rate; dB values are numbers.
- trim_clip {clip, start, offset, len}: timeline start, first source frame, length (crop and edge trims)
- move_clip {clip, track, start}
- set_clip_gain {clip, gain_db} (-96..24)
- set_clip_fades {clip, fade_in, fade_out, curve_in?, curve_out?} (frames; curves \"linear\"|\"exp\"|\"s\")
- set_envelope {clip, points: [{at, gain}]} (at: source frame, gain: linear 0..1.25)
- reverse_clip {clip, reversed}
- stretch_clip {clip, stretch, start?} (timeline frames per source frame, 0.25..4, keeps pitch)
- set_clip_pitch {clip, semitones} (-24..24, keeps length)
- add_clip {source, track, start}, delete_clip {clip}, split_clip {clip, at}, duplicate_clip {clip}
- add_track {name}, delete_track {track}, rename_track {track, name}, move_track {track, index}
- set_track_mix {track, gain_db?, pan?, muted?, solo?} (gain -96..12, pan -1..1)
- set_track_eq {track, bands: [{kind, freq, gainDb, q, slope}], bypass?} (kind: \"bell\"|\"low_shelf\"|\"high_shelf\"|\"low_cut\"|\"high_cut\"|\"notch\"|\"band_pass\"; slope: dB/octave for cuts)
- set_track_color {track, color} (0..7 or null), set_tempo {bpm}, set_master_gain {gain_db} (-96..12)";

fn range_props() -> Value {
    json!({
        "from": { "type": "number", "description": "Start, seconds on the timeline. Default: the first clip heard." },
        "to": { "type": "number", "description": "End, seconds. Default: the end of the last clip." },
        "track": { "type": "integer", "description": "Only this track (its volume, pan and EQ apply)." },
        "clip": { "type": "integer", "description": "Only this clip." },
    })
}

fn tools() -> Value {
    let mut image = range_props();
    image["width"] =
        json!({ "type": "integer", "description": "Pixels, 64 to 4000; default 1000." });
    let mut export = range_props();
    if let Some(o) = export.as_object_mut() {
        o.remove("track");
        o.remove("clip");
        o.insert(
            "path".into(),
            json!({ "type": "string", "description": "A new .wav or .mp3 file." }),
        );
        o.insert("bits".into(), json!({ "type": "integer", "enum": [16, 24, 32], "description": "WAV depth; 32 is float." }));
        o.insert("rate".into(), json!({ "type": "integer", "description": "Sample rate of the file, if not the session's." }));
        o.insert(
            "kbps".into(),
            json!({ "type": "integer", "description": "MP3 bitrate." }),
        );
        o.insert("overwrite".into(), json!({ "type": "boolean", "description": "Replace an existing file, keeping a backup." }));
    }
    let obj = |props: Value, required: &[&str]| json!({ "type": "object", "properties": props, "required": required });
    json!([
        { "name": "open", "description": "Open a WAV or MP3 (a scratch session that edits that file) or a .dawg project. Replaces whatever was open, unsaved edits included.",
          "inputSchema": obj(json!({ "path": { "type": "string", "description": "Absolute path." } }), &["path"]) },
        { "name": "new_project", "description": "Start an empty, unsaved project. The first file imported sets its sample rate.",
          "inputSchema": obj(json!({}), &[]) },
        { "name": "get_project", "description": "The open session: tracks, clips, sources, tempo, master, history. Frames are at `rate`.",
          "inputSchema": obj(json!({}), &[]) },
        { "name": "import_files", "description": "Add WAV or MP3 files as clips: each on a new track, or end to end on `track`. One undo step.",
          "inputSchema": obj(json!({
              "paths": { "type": "array", "items": { "type": "string" } },
              "track": { "type": "integer", "description": "Put them on this track instead of new ones." },
              "start": { "type": "number", "description": "Seconds on the timeline; default 0." }
          }), &["paths"]) },
        { "name": "apply", "description": format!("Edit the session: the commands apply together as one undo step named \"AI: <label>\", or none do.\n{COMMANDS}"),
          "inputSchema": obj(json!({
              "commands": { "type": "array", "items": { "type": "object" } },
              "label": { "type": "string", "description": "A few words for the history, like \"tighten kick tail\"." }
          }), &["commands", "label"]) },
        { "name": "undo", "description": "Undo the last edit.", "inputSchema": obj(json!({}), &[]) },
        { "name": "redo", "description": "Redo the last undone edit.", "inputSchema": obj(json!({}), &[]) },
        { "name": "analyze", "description": "Measure the mix, a track or a clip: peak, RMS, integrated and short-term LUFS, crest factor, where sound starts and ends, onsets, spectral centroid, and an RMS curve in 100 ms steps.",
          "inputSchema": obj(range_props(), &[]) },
        { "name": "render_image", "description": "A waveform picture of the mix (one lane per track), a track or a clip. Red marks samples past 0 dBFS; faint lines are seconds.",
          "inputSchema": obj(image, &[]) },
        { "name": "export", "description": "Mix down to a WAV or MP3. A scratch session with nothing but its own clip saves in the original's format.",
          "inputSchema": obj(export, &["path"]) },
        { "name": "save_original", "description": "Scratch session only: write the edit over the file that was opened, keeping a backup the app can restore.",
          "inputSchema": obj(json!({}), &[]) },
        { "name": "save_project", "description": "Save as a .dawg project, at `path` or where it was last saved.",
          "inputSchema": obj(json!({ "path": { "type": "string", "description": "Ends in .dawg." } }), &[]) },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let mut s = Server::new();
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
        let mut s = Server::new();
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
        std::env::set_var("DAWG_BACKUPS", dir.join("backups"));
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
