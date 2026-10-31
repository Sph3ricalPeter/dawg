//! `dawg-cli`: quick edits and measurements on audio files and `.dawg`
//! projects from a terminal or script, and (`dawg-cli mcp`) an MCP server so
//! an AI agent can work as a coproducer on the same sessions.
//!
//! Edits are dry runs unless `--yes` (write over the file, with a backup) or
//! `--out` (a new file) says where they go.

use std::path::PathBuf;
use std::process::ExitCode;

use dawg_cli::{backup_dir, frames, mcp, open, tools};
use dawg_core::analysis::Analysis;
use dawg_core::file::Codec;
use dawg_core::session::{is_project, ExportOptions, Session};
use dawg_core::Command;

const USAGE: &str = "\
dawg-cli: dawg from the command line

USAGE
  dawg-cli info <file> [--json]
  dawg-cli analyze <file> [--track ID] [--clip ID] [--from S] [--to S] [--json]
  dawg-cli render <file> <out.png> [--width PX] [--from S] [--to S]
  dawg-cli trim <audio> [--from S] [--to S] [--auto]   [--yes | --out FILE]
  dawg-cli gain <audio> <DB>                                [--yes | --out FILE]
  dawg-cli normalize <audio> [--peak DB | --lufs LUFS]      [--yes | --out FILE]
  dawg-cli export <file> <out.wav|out.mp3> [--bits 16|24|32] [--rate HZ] [--kbps N] [--from S] [--to S]
  dawg-cli mcp

<file> is a WAV, an MP3 or a .dawg project; <audio> is a WAV or MP3.
Times are seconds. --auto trims to where sound is above -60 dBFS. Edits only print what they would do
until --yes writes over the file (keeping a backup) or --out writes a new one.
`dawg-cli mcp` serves the Model Context Protocol on stdin/stdout.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("dawg-cli: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Parsed flags and the arguments between them.
struct Args {
    pos: Vec<String>,
    flags: Vec<(String, Option<String>)>,
}

/// Flags that take no value.
const SWITCHES: &[&str] = &["--json", "--yes", "--auto"];

impl Args {
    fn parse(raw: Vec<String>) -> Result<Args, String> {
        let mut pos = Vec::new();
        let mut flags = Vec::new();
        let mut it = raw.into_iter().peekable();
        while let Some(a) = it.next() {
            if a.starts_with("--") {
                let value = if SWITCHES.contains(&a.as_str()) {
                    None
                } else {
                    Some(it.next().ok_or_else(|| format!("{a} needs a value"))?)
                };
                flags.push((a, value));
            } else {
                pos.push(a);
            }
        }
        Ok(Args { pos, flags })
    }

    fn has(&self, name: &str) -> bool {
        self.flags.iter().any(|(f, _)| f == name)
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.flags
            .iter()
            .find(|(f, _)| f == name)
            .and_then(|(_, v)| v.as_deref())
    }

    fn num<T: std::str::FromStr>(&self, name: &str) -> Result<Option<T>, String> {
        self.get(name)
            .map(|v| {
                v.parse()
                    .map_err(|_| format!("{name}: \"{v}\" isn't a number"))
            })
            .transpose()
    }

    fn arg(&self, i: usize, what: &str) -> Result<&str, String> {
        self.pos
            .get(i)
            .map(String::as_str)
            .ok_or_else(|| format!("missing {what}\n\n{USAGE}"))
    }
}

fn run(raw: Vec<String>) -> Result<(), String> {
    let Some(cmd) = raw.first().cloned() else {
        print!("{USAGE}");
        return Ok(());
    };
    let a = Args::parse(raw[1..].to_vec())?;
    match cmd.as_str() {
        "info" => info(&a),
        "analyze" => analyze(&a),
        "render" => render(&a),
        "trim" => trim(&a),
        "gain" => gain(&a),
        "normalize" => normalize(&a),
        "export" => export(&a),
        "mcp" => mcp::serve(),
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            Ok(())
        }
        "-V" | "--version" => {
            println!("dawg-cli {}", dawg_core::VERSION);
            Ok(())
        }
        other => Err(format!("no command \"{other}\"\n\n{USAGE}")),
    }
}

fn range(a: &Args, s: &Session) -> Result<Option<(u64, u64)>, String> {
    let rate = s.state().rate;
    let from = a.num::<f64>("--from")?;
    let to = a.num::<f64>("--to")?;
    if from.is_none() && to.is_none() {
        return Ok(None);
    }
    let st = s.state();
    let a0 = from.map_or(st.start, |f| frames(f, rate));
    let b0 = to.map_or(st.end, |t| frames(t, rate));
    if b0 <= a0 {
        return Err("--to must be after --from".into());
    }
    Ok(Some((a0, b0)))
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn db(v: Option<f64>, unit: &str) -> String {
    v.map_or("silent".into(), |v| format!("{v:.1} {unit}"))
}

fn print_analysis(x: &Analysis) {
    println!("  length     {:.3} s", x.seconds);
    println!("  peak       {}", db(x.peak_db, "dBFS"));
    println!("  rms        {}", db(x.rms_db, "dBFS"));
    let lufs = |v: Option<f64>| match (v, x.peak_db) {
        (Some(v), _) => format!("{v:.1} LUFS"),
        (None, Some(_)) => "too short to measure".into(),
        (None, None) => "silent".into(),
    };
    println!("  loudness   {}", lufs(x.lufs));
    println!("  max short  {}", lufs(x.max_short_term_lufs));
    println!("  crest      {}", db(x.crest_db, "dB"));
    if let (Some(a), Some(b)) = (x.sound_from, x.sound_to) {
        println!("  sound      {a:.3} to {b:.3} s");
    }
    if let Some(c) = x.centroid_hz {
        println!("  brightness {c:.0} Hz centroid");
    }
    if !x.onsets.is_empty() {
        let shown: Vec<String> = x
            .onsets
            .iter()
            .take(12)
            .map(|t| format!("{t:.2}"))
            .collect();
        let more = x.onsets.len().saturating_sub(12);
        let more = if more > 0 {
            format!(" (+{more})")
        } else {
            String::new()
        };
        println!("  onsets     {}{more}", shown.join(" "));
    }
}

fn info(a: &Args) -> Result<(), String> {
    let path = PathBuf::from(a.arg(0, "a file")?);
    let s = open(&path)?;
    let st = s.state();
    let x = s.analyze(None, None, None).ok();
    if a.has("--json") {
        let v = serde_json::json!({ "session": tools::summary(&s), "analysis": x });
        println!("{}", json(&v));
        return Ok(());
    }
    println!("{}", st.name);
    if st.scratch {
        let f = &st.format;
        let what = match st.codec {
            Codec::Mp3 => format!("MP3 {} kbps", st.kbps.unwrap_or(0)),
            Codec::Wav if f.float => format!("{}-bit float WAV", f.bits),
            Codec::Wav => format!("{}-bit WAV", f.bits),
        };
        println!(
            "  {what}, {} Hz, {} ch, {:.3} s",
            f.sample_rate,
            f.channels,
            st.frames as f64 / st.rate as f64
        );
    } else {
        println!(
            "  project, {} Hz, {:.2} BPM, master {:+.1} dB",
            st.rate, st.bpm, st.master_db
        );
        for t in &st.tracks {
            println!(
                "  track {} \"{}\": {} clip(s), {:+.1} dB{}{}",
                t.id,
                t.name,
                t.clips.len(),
                t.gain_db,
                if t.muted { ", muted" } else { "" },
                if t.solo { ", solo" } else { "" }
            );
        }
    }
    if let Some(x) = x {
        print_analysis(&x);
    }
    Ok(())
}

fn analyze(a: &Args) -> Result<(), String> {
    let path = PathBuf::from(a.arg(0, "a file")?);
    let s = open(&path)?;
    let x = s
        .analyze(range(a, &s)?, a.num("--track")?, a.num("--clip")?)
        .map_err(|e| e.to_string())?;
    if a.has("--json") {
        println!("{}", json(&x));
    } else {
        println!("{}", s.state().name);
        print_analysis(&x);
    }
    Ok(())
}

fn render(a: &Args) -> Result<(), String> {
    let path = PathBuf::from(a.arg(0, "a file")?);
    let out = PathBuf::from(a.arg(1, "the PNG to write")?);
    let s = open(&path)?;
    let width = a.num::<usize>("--width")?.unwrap_or(1200).clamp(64, 8000);
    let bytes = tools::picture(&s, range(a, &s)?, None, None, width)?;
    dawg_core::save::write_new(&out, &bytes).map_err(|e| format!("{}: {e}", out.display()))?;
    println!("wrote {}", out.display());
    Ok(())
}

/// Opens an audio file for a one-clip edit: the session and its clip.
fn scratch(a: &Args) -> Result<(Session, u64), String> {
    let path = PathBuf::from(a.arg(0, "an audio file")?);
    if is_project(&path) {
        return Err("trim, gain and normalize work on WAV and MP3 files; use `export` or the MCP server for projects".into());
    }
    let s = open(&path)?;
    let clip = s.state().tracks[0].clips[0].id;
    Ok((s, clip))
}

/// Shows what an edit does, then writes it where the flags say.
fn finish(a: &Args, mut s: Session, what: String) -> Result<(), String> {
    let p = s.preview();
    let rate = s.state().rate as f64;
    println!("{what}");
    if p.untouched {
        println!("  nothing to change");
        return Ok(());
    }
    println!(
        "  {:.3} s -> {:.3} s, peak {:.1} dBFS{}",
        p.frames_before as f64 / rate,
        p.frames_after as f64 / rate,
        p.peak_db,
        if p.clipped { " (clips)" } else { "" }
    );
    if let Some(out) = a.get("--out") {
        let out = PathBuf::from(out);
        let codec = Codec::for_path(&out).unwrap_or(s.codec());
        s.save_as_new(&out, codec)
            .map_err(|e| format!("{}: {e}", out.display()))?;
        println!("  wrote {}", out.display());
    } else if a.has("--yes") {
        let r = s
            .replace_original(&backup_dir())
            .map_err(|e| e.to_string())?;
        println!(
            "  saved {} (backup: {})",
            r.original.display(),
            r.backup.display()
        );
    } else {
        println!("  dry run: add --yes to write over the file (a backup is kept), or --out FILE");
    }
    Ok(())
}

fn trim(a: &Args) -> Result<(), String> {
    let (mut s, clip) = scratch(a)?;
    let st = s.state();
    let rate = st.rate;
    let total = st.frames;
    let (mut from, mut to) = (0, total);
    if a.has("--auto") {
        let x = s.analyze(None, None, None).map_err(|e| e.to_string())?;
        from = frames(x.sound_from.unwrap_or(0.0), rate);
        to = frames(x.sound_to.unwrap_or(0.0), rate).max(from + 1);
    }
    if let Some(f) = a.num::<f64>("--from")? {
        from = frames(f, rate);
    }
    if let Some(t) = a.num::<f64>("--to")? {
        to = frames(t, rate);
    }
    let to = to.min(total);
    if to <= from {
        return Err("nothing left: the end is before the start".into());
    }
    s.apply(
        &Command::TrimClip {
            clip,
            start: 0,
            offset: from,
            len: to - from,
        },
        false,
    )
    .map_err(|e| e.to_string())?;
    let what = format!(
        "trim {} to {:.3}..{:.3} s",
        st.name,
        from as f64 / rate as f64,
        to as f64 / rate as f64
    );
    finish(a, s, what)
}

fn gain(a: &Args) -> Result<(), String> {
    let (mut s, clip) = scratch(a)?;
    let v: f32 = a
        .arg(1, "the gain in dB")?
        .parse()
        .map_err(|_| "the gain must be a number of dB")?;
    s.apply(&Command::SetClipGain { clip, gain_db: v }, false)
        .map_err(|e| e.to_string())?;
    let what = format!("gain {} by {v:+.1} dB", s.state().name);
    finish(a, s, what)
}

fn normalize(a: &Args) -> Result<(), String> {
    let (mut s, clip) = scratch(a)?;
    let x = s.analyze(None, None, None).map_err(|e| e.to_string())?;
    let (by, what) = if let Some(l) = a.num::<f64>("--lufs")? {
        let now = x.lufs.ok_or("too short or quiet to measure loudness")?;
        (l - now, format!("to {l:.1} LUFS (now {now:.1})"))
    } else {
        let p = a.num::<f64>("--peak")?.unwrap_or(-1.0);
        let now = x.peak_db.ok_or("the file is silent")?;
        (p - now, format!("to peak {p:.1} dBFS (now {now:.1})"))
    };
    s.apply(
        &Command::SetClipGain {
            clip,
            gain_db: by as f32,
        },
        false,
    )
    .map_err(|e| e.to_string())?;
    let what = format!("normalize {} {what}: {by:+.2} dB", s.state().name);
    finish(a, s, what)
}

fn export(a: &Args) -> Result<(), String> {
    let path = PathBuf::from(a.arg(0, "a file")?);
    let out = PathBuf::from(a.arg(1, "the file to write")?);
    let s = open(&path)?;
    let codec = Codec::for_path(&out).ok_or("the output must end in .wav or .mp3")?;
    let opts = ExportOptions {
        range: range(a, &s)?,
        bits: a.num("--bits")?,
        rate: a.num("--rate")?,
        kbps: a.num("--kbps")?,
    };
    s.export_new(&out, codec, &opts)
        .map_err(|e| format!("{}: {e}", out.display()))?;
    println!("wrote {}", out.display());
    Ok(())
}
