//! The Browser panel's side: folder listings, file search, and previews
//! that play through the same output as the session without touching it.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use dawg_core::file::{AudioFile, Codec};
use dawg_core::{Clip, Project, Source, Track};
use serde::Serialize;
use tauri::State;

use crate::commands::{AppState, Error, Result};

/// Files the browser lists.
fn is_audio(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "wav" | "wave" | "mp3"))
}

fn hidden(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('$')
}

#[derive(Serialize)]
pub struct Listing {
    dirs: Vec<String>,
    files: Vec<String>,
}

/// The subfolders and audio files in `path`, by name.
#[tauri::command]
pub fn list_dir(path: PathBuf) -> Result<Listing> {
    let rd =
        fs::read_dir(&path).map_err(|e| Error::new("io", format!("{}: {e}", path.display())))?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if hidden(&name) {
            continue;
        }
        match e.file_type() {
            Ok(t) if t.is_dir() => dirs.push(name),
            Ok(_) if is_audio(&e.path()) => files.push(name),
            _ => {}
        }
    }
    let key = |s: &String| s.to_lowercase();
    dirs.sort_by_key(key);
    files.sort_by_key(key);
    Ok(Listing { dirs, files })
}

/// Audio files under `roots` whose names hold every word of `query`, at
/// most `MAX_HITS`, looking at no more than `MAX_SCAN` entries.
#[tauri::command]
pub fn search_files(roots: Vec<PathBuf>, query: String) -> Vec<PathBuf> {
    const MAX_HITS: usize = 200;
    const MAX_SCAN: usize = 50_000;
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    let mut seen = 0;
    let mut stack: Vec<(PathBuf, usize)> = roots.into_iter().rev().map(|r| (r, 0)).collect();
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut subs = Vec::new();
        for e in rd.flatten() {
            seen += 1;
            if seen > MAX_SCAN {
                return hits;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if hidden(&name) {
                continue;
            }
            let path = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() && depth < 12 => subs.push(path),
                Ok(_) if is_audio(&path) => {
                    let lower = name.to_lowercase();
                    if words.iter().all(|w| lower.contains(w)) {
                        hits.push(path);
                        if hits.len() >= MAX_HITS {
                            return hits;
                        }
                    }
                }
                _ => {}
            }
        }
        subs.sort();
        stack.extend(subs.into_iter().rev().map(|p| (p, depth + 1)));
    }
    hits
}

/// The file being previewed, decoded once.
#[derive(Default)]
pub struct Previews {
    last: Mutex<Option<(PathBuf, Arc<Source>, u32)>>,
}

impl Previews {
    fn load(&self, path: &Path) -> Result<(Arc<Source>, u32, AudioFile)> {
        let bytes =
            fs::read(path).map_err(|e| Error::new("io", format!("{}: {e}", path.display())))?;
        let file = AudioFile::parse(bytes).map_err(|e| Error::new("format", e.to_string()))?;
        let src = Arc::new(file.decode());
        let rate = file.sample_rate();
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((path.to_path_buf(), src.clone(), rate));
        Ok((src, rate, file))
    }

    fn get(&self, path: &Path) -> Result<(Arc<Source>, u32)> {
        if let Some((p, s, r)) = &*self.last.lock().unwrap_or_else(|e| e.into_inner()) {
            if p == path {
                return Ok((s.clone(), *r));
            }
        }
        self.load(path).map(|(s, r, _)| (s, r))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    seconds: f64,
    rate: u32,
    channels: u16,
    /// "24-bit WAV", "MP3 192 kbps".
    format: String,
    peak_db: Option<f32>,
    /// Loudest sample per bucket, 0 to 1 (more past 0 dBFS).
    peaks: Vec<f32>,
}

/// What the preview pane shows: format, length, peak and a waveform.
#[tauri::command]
pub fn preview_info(
    previews: State<Previews>,
    path: PathBuf,
    buckets: usize,
) -> Result<PreviewInfo> {
    let (src, rate, file) = previews.load(&path)?;
    let ch = src.channels().max(1) as usize;
    let frames = src.frames() as usize;
    let buckets = buckets.clamp(1, 4000);
    let s = src.samples();
    let mut peaks = vec![0f32; buckets];
    let mut top = 0f32;
    for (b, p) in peaks.iter_mut().enumerate() {
        let a = b * frames / buckets;
        let z = ((b + 1) * frames / buckets).max(a + 1).min(frames);
        for x in s.get(a * ch..z * ch).unwrap_or(&[]) {
            *p = p.max(x.abs());
        }
        top = top.max(*p);
    }
    let format = match file.codec() {
        Codec::Mp3 => format!("MP3 {} kbps", file.kbps().unwrap_or(0)),
        Codec::Wav => match file.wav_format() {
            Some(f) if f.float => format!("{}-bit float WAV", f.bits),
            Some(f) => format!("{}-bit WAV", f.bits),
            None => "WAV".into(),
        },
    };
    Ok(PreviewInfo {
        seconds: frames as f64 / rate as f64,
        rate,
        channels: src.channels(),
        format,
        peak_db: (top > 0.0).then(|| 20.0 * top.log10()),
        peaks,
    })
}

/// Plays a file on its own from `from` seconds; the session stays as it
/// is and plays again on the next Play.
#[tauri::command]
pub fn preview_play(
    state: State<AppState>,
    previews: State<Previews>,
    path: PathBuf,
    from: f64,
) -> Result<()> {
    let (src, rate) = previews.get(&path)?;
    let frames = src.frames();
    let mut p = Project::new(rate);
    p.sources.push(src.clone());
    let id = p.new_id();
    let clip = p.new_id();
    p.tracks.push(Track {
        id,
        clips: vec![Clip {
            id: clip,
            ..Clip::new(src, 0)
        }],
        ..Track::default()
    });
    let start = ((from.max(0.0) * rate as f64) as u64).min(frames.saturating_sub(1));
    state
        .preview(Arc::new(p), start, frames)
        .map_err(|e| Error::new("audio", e))
}

#[tauri::command]
pub fn preview_stop(state: State<AppState>) {
    state.preview_stop();
}

#[derive(Serialize)]
pub struct PreviewStatus {
    playing: bool,
    seconds: f64,
}

/// Whether a preview is playing, and where.
#[tauri::command]
pub fn preview_status(state: State<AppState>, previews: State<Previews>) -> PreviewStatus {
    let rate = previews
        .last
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map_or(48_000, |(_, _, r)| *r);
    let (playing, at) = state.preview_status();
    PreviewStatus {
        playing,
        seconds: at as f64 / rate as f64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_and_finds_audio_only() {
        let d = std::env::temp_dir().join(format!("dawg-browser-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("Kicks/Deep")).unwrap();
        fs::create_dir_all(d.join(".hidden")).unwrap();
        for f in [
            "Kicks/kick_01.wav",
            "Kicks/Deep/kick_sub.MP3",
            "Kicks/notes.txt",
            "snare.wav",
        ] {
            fs::write(d.join(f), b"x").unwrap();
        }
        let l = list_dir(d.clone()).ok().unwrap();
        assert_eq!(l.dirs, ["Kicks"]);
        assert_eq!(l.files, ["snare.wav"]);
        let l = list_dir(d.join("Kicks")).ok().unwrap();
        assert_eq!((l.dirs.len(), l.files.len()), (1, 1));
        let hits = search_files(vec![d.clone()], "KICK".into());
        assert_eq!(hits.len(), 2);
        assert_eq!(
            search_files(vec![d.clone()], "kick sub".into()),
            [d.join("Kicks").join("Deep").join("kick_sub.MP3")]
        );
        assert!(search_files(vec![d.clone()], "  ".into()).is_empty());
        let _ = fs::remove_dir_all(&d);
    }
}
