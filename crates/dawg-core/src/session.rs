//! An editing session: the "Edit in dawg" scratch session, widened to many
//! tracks.
//!
//! The file it was opened from becomes one clip on one track at its own
//! sample rate. More files can be added onto other tracks; they are converted
//! to the session's rate. Edits are [`Command`]s; every committed edit is one
//! undo step, and a drag sends transient commands that collapse into one step
//! when it ends.
//!
//! Export has two paths. While the session is still just the original file's
//! clip, saving keeps that file's own format and untouched bytes
//! ([`AudioFile::render`]). Anything more is a mixdown through the renderer,
//! from the first clip's start to the last clip's end.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::command::{gain_to_db, Command, CommandError};
use crate::file::{AudioFile, Codec, FileError};
use crate::model::{Clip, EnvPoint, Project, Source, Track};
use crate::mp3::{self, Tags};
use crate::peaks::Peaks;
use crate::render::{render, OUT_CHANNELS};
use crate::resample::resample;
use crate::save::{self, FileStamp, Replaced, SaveError};
use crate::wav::{encode_simple, WavFormat};

/// Undo steps kept.
const HISTORY: usize = 200;

#[derive(Debug)]
pub enum OpenError {
    Io(io::Error),
    Format(FileError),
    Empty,
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpenError::Io(e) => write!(f, "{e}"),
            OpenError::Format(e) => write!(f, "{e}"),
            OpenError::Empty => write!(f, "the file has no audio in it"),
        }
    }
}

impl std::error::Error for OpenError {}

/// The file the session was opened from.
struct Origin {
    path: PathBuf,
    file: Arc<AudioFile>,
    stamp: FileStamp,
    /// Its id in the project's sources.
    source: u64,
}

/// What the session keeps about each file added to it.
struct SourceInfo {
    path: PathBuf,
    source: Arc<Source>,
    peaks: Peaks,
    /// The file's own rate, before conversion to the session's.
    rate: u32,
}

pub struct Session {
    origin: Origin,
    sources: BTreeMap<u64, SourceInfo>,
    project: Arc<Project>,
    /// The state that matches the file on disk.
    saved: Arc<Project>,
    undo: Vec<Arc<Project>>,
    redo: Vec<Arc<Project>>,
    /// A drag is under way; its first transient command took the undo step.
    in_gesture: bool,
}

/// What the UI shows about the session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    /// The file the session was opened from.
    pub path: PathBuf,
    pub name: String,
    pub codec: Codec,
    /// Sample layout of that file. For MP3, `bits` and `container_bytes` are
    /// 0.
    pub format: WavFormat,
    /// MP3 average bitrate in kbps.
    pub kbps: Option<u32>,
    /// Frames in that file.
    pub frames: u64,
    /// The session's sample rate; every source plays at it.
    pub rate: u32,
    pub tracks: Vec<TrackState>,
    pub sources: Vec<SourceState>,
    /// Timeline frames from the first clip heard to the end of the last:
    /// what a mixdown covers. Both 0 when nothing is heard.
    pub start: u64,
    pub end: u64,
    /// Export saves the original file's clip in the file's own format rather
    /// than a mixdown.
    pub simple: bool,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    /// Chunk ids carried over on save, besides `fmt ` and `data`.
    pub extra_chunks: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackState {
    pub id: u64,
    pub name: String,
    pub gain_db: f32,
    pub pan: f32,
    pub muted: bool,
    pub solo: bool,
    pub clips: Vec<ClipState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipState {
    pub id: u64,
    pub source: u64,
    pub start: u64,
    pub offset: u64,
    pub len: u64,
    pub gain_db: f32,
    pub fade_in: u64,
    pub fade_out: u64,
    pub envelope: Vec<EnvPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceState {
    pub id: u64,
    pub name: String,
    pub path: PathBuf,
    /// Frames at the session's rate.
    pub frames: u64,
    pub channels: u16,
    /// The file's own rate.
    pub rate: u32,
}

/// What saving would produce.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePreview {
    pub frames_before: u64,
    pub frames_after: u64,
    pub cut_start: u64,
    pub cut_end: u64,
    /// Highest absolute sample of the result, in dBFS.
    pub peak_db: f32,
    /// Integer formats only: samples that hit full scale after gain.
    pub clipped: bool,
    pub untouched: bool,
}

/// Where added files go.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    /// End to end on this track; `None` puts each file on a new track.
    pub track: Option<u64>,
    /// Timeline frame of the first clip.
    pub start: u64,
}

/// What adding files did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// The new clips, in the order the files were given.
    pub clips: Vec<u64>,
    /// Files that could not be added, with why.
    pub failed: Vec<(PathBuf, String)>,
}

fn read_file(path: &Path) -> Result<(AudioFile, FileStamp), OpenError> {
    let stamp = FileStamp::of(path).map_err(OpenError::Io)?;
    // Read once and keep no handle open, so other programs (and our own
    // replace) can write the file.
    let bytes = fs::read(path).map_err(OpenError::Io)?;
    let file = AudioFile::parse(bytes).map_err(OpenError::Format)?;
    if file.frames() == 0 {
        return Err(OpenError::Empty);
    }
    Ok((file, stamp))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

impl Session {
    pub fn open(path: &Path) -> Result<Session, OpenError> {
        let (file, stamp) = read_file(path)?;
        Ok(Self::from_file(path.to_path_buf(), file, stamp))
    }

    fn from_file(path: PathBuf, file: AudioFile, stamp: FileStamp) -> Session {
        let rate = file.sample_rate();
        let mut project = Project::new(rate);
        let source_id = project.new_id();
        let source = Arc::new(file.decode().with_id(source_id));
        let track = project.new_id();
        let clip = project.new_id();
        project.sources.push(source.clone());
        project.tracks.push(Track {
            id: track,
            name: file_stem(&path),
            clips: vec![Clip {
                id: clip,
                ..Clip::new(source.clone(), 0)
            }],
            ..Track::default()
        });
        let mut sources = BTreeMap::new();
        sources.insert(
            source_id,
            SourceInfo {
                path: path.clone(),
                peaks: Peaks::new(&source),
                source,
                rate,
            },
        );
        let project = Arc::new(project);
        Session {
            origin: Origin {
                path,
                file: Arc::new(file),
                stamp,
                source: source_id,
            },
            sources,
            saved: project.clone(),
            project,
            undo: Vec::new(),
            redo: Vec::new(),
            in_gesture: false,
        }
    }

    /// The file the session was opened from.
    pub fn path(&self) -> &Path {
        &self.origin.path
    }

    pub fn project(&self) -> &Arc<Project> {
        &self.project
    }

    /// A source's audio and peaks, by id. Sources stay known after an undo
    /// takes their clips away.
    pub fn source(&self, id: u64) -> Option<(&Arc<Source>, &Peaks)> {
        self.sources.get(&id).map(|s| (&s.source, &s.peaks))
    }

    pub fn clip(&self, id: u64) -> Option<&Clip> {
        self.project.clip(id).map(|(_, c)| c)
    }

    pub fn dirty(&self) -> bool {
        !self.project.same_edit(&self.saved)
    }

    /// The one clip export saves in the original file's own format: the
    /// session's only clip, from that file, on a track that plays it as is.
    fn simple_clip(&self) -> Option<&Clip> {
        let p = &self.project;
        let mut clips = p.clips();
        let (track, clip) = clips.next()?;
        let alone = clips.next().is_none();
        (alone
            && clip.source.id() == self.origin.source
            && track.gain == 1.0
            && track.pan == 0.0
            && p.audible(track))
        .then_some(clip)
    }

    pub fn state(&self) -> SessionState {
        let p = &self.project;
        SessionState {
            path: self.origin.path.clone(),
            name: file_name(&self.origin.path),
            codec: self.origin.file.codec(),
            format: self.format(),
            kbps: self.origin.file.kbps(),
            frames: self.origin.file.frames(),
            rate: p.sample_rate,
            tracks: p
                .tracks
                .iter()
                .map(|t| TrackState {
                    id: t.id,
                    name: t.name.clone(),
                    gain_db: gain_to_db(t.gain),
                    pan: t.pan,
                    muted: t.muted,
                    solo: t.solo,
                    clips: t
                        .clips
                        .iter()
                        .map(|c| ClipState {
                            id: c.id,
                            source: c.source.id(),
                            start: c.start,
                            offset: c.offset,
                            len: c.len,
                            gain_db: gain_to_db(c.gain),
                            fade_in: c.fade_in,
                            fade_out: c.fade_out,
                            envelope: c.envelope.to_vec(),
                        })
                        .collect(),
                })
                .collect(),
            sources: self
                .sources
                .iter()
                .map(|(&id, s)| SourceState {
                    id,
                    name: file_name(&s.path),
                    path: s.path.clone(),
                    frames: s.source.frames(),
                    channels: s.source.channels(),
                    rate: s.rate,
                })
                .collect(),
            start: p.audible_span().map_or(0, |s| s.0),
            end: p.audible_span().map_or(0, |s| s.1),
            simple: self.simple_clip().is_some(),
            dirty: self.dirty(),
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            extra_chunks: self.origin.file.extra_chunks(),
            truncated: self.origin.file.truncated(),
        }
    }

    /// Applies `cmd`. A `transient` command is part of a drag: the first one
    /// records the undo step and the rest replace the live state until
    /// [`Session::end_gesture`].
    pub fn apply(&mut self, cmd: &Command, transient: bool) -> Result<(), CommandError> {
        let next = cmd.apply(&self.project)?;
        self.commit(next, transient);
        Ok(())
    }

    fn commit(&mut self, next: Project, transient: bool) {
        if !self.in_gesture {
            if next.same_edit(&self.project) {
                return;
            }
            self.push_undo();
        }
        self.project = Arc::new(next);
        self.in_gesture = true;
        if !transient {
            self.end_gesture();
        }
    }

    /// Ends a drag. A drag that ended where it began leaves no undo step.
    pub fn end_gesture(&mut self) {
        if !self.in_gesture {
            return;
        }
        self.in_gesture = false;
        if self.undo.last().is_some_and(|p| p.same_edit(&self.project)) {
            self.undo.pop();
        }
    }

    fn push_undo(&mut self) {
        self.undo.push(self.project.clone());
        if self.undo.len() > HISTORY {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    pub fn undo(&mut self) -> bool {
        self.end_gesture();
        let Some(p) = self.undo.pop() else {
            return false;
        };
        self.redo.push(std::mem::replace(&mut self.project, p));
        true
    }

    pub fn redo(&mut self) -> bool {
        self.end_gesture();
        let Some(p) = self.redo.pop() else {
            return false;
        };
        self.undo.push(std::mem::replace(&mut self.project, p));
        true
    }

    /// Adds WAV or MP3 files as clips, converted to the session's rate, in
    /// one undo step. Files that fail are reported and skipped.
    pub fn import(&mut self, paths: &[PathBuf], at: Placement) -> Result<Imported, CommandError> {
        self.end_gesture();
        let mut p = (*self.project).clone();
        if let Some(t) = at.track {
            if p.track(t).is_none() {
                return Err(CommandError(format!("no track {t}")));
            }
        }
        let mut out = Imported {
            clips: Vec::new(),
            failed: Vec::new(),
        };
        let mut cursor = at.start;
        for path in paths {
            let file = match read_file(path) {
                Ok((file, _)) => file,
                Err(e) => {
                    out.failed.push((path.clone(), e.to_string()));
                    continue;
                }
            };
            let id = p.new_id();
            let rate = file.sample_rate();
            let source = Arc::new(resample(&file.decode(), rate, p.sample_rate).with_id(id));
            p.sources.push(source.clone());
            let track = match at.track {
                Some(t) => t,
                None => {
                    let t = p.next_id;
                    Command::AddTrack {
                        name: file_stem(path),
                    }
                    .apply_in_place(&mut p)?;
                    t
                }
            };
            out.clips.push(p.next_id);
            Command::AddClip {
                source: id,
                track,
                start: cursor,
            }
            .apply_in_place(&mut p)?;
            if at.track.is_some() {
                cursor += source.frames();
            }
            self.sources.insert(
                id,
                SourceInfo {
                    path: path.clone(),
                    peaks: Peaks::new(&source),
                    source,
                    rate,
                },
            );
        }
        if !out.clips.is_empty() {
            self.commit(p, false);
        }
        Ok(out)
    }

    /// The format of the file being edited.
    pub fn codec(&self) -> Codec {
        self.origin.file.codec()
    }

    fn format(&self) -> WavFormat {
        let f = &self.origin.file;
        f.wav_format().unwrap_or(WavFormat {
            channels: f.channels(),
            sample_rate: f.sample_rate(),
            bits: 0,
            container_bytes: 0,
            float: false,
        })
    }

    /// The mixdown, interleaved, from the first clip to the last: stereo, or
    /// mono when everything heard is mono and centred.
    fn mixdown(&self) -> Result<(u16, Vec<f32>), SessionSaveError> {
        let p = &self.project;
        let (start, end) = p.audible_span().ok_or(SessionSaveError::Nothing)?;
        let stereo = render(self.project.clone(), start, (end - start) as usize);
        let mono = p
            .tracks
            .iter()
            .filter(|t| p.audible(t))
            .all(|t| t.pan == 0.0 && t.clips.iter().all(|c| c.source.channels() == 1));
        if mono {
            Ok((1, stereo.iter().step_by(OUT_CHANNELS).copied().collect()))
        } else {
            Ok((OUT_CHANNELS as u16, stereo))
        }
    }

    /// The file the current edit would save, as `codec`.
    pub fn render_file(&self, codec: Codec) -> Result<Vec<u8>, SessionSaveError> {
        if let Some(clip) = self.simple_clip() {
            return Ok(self.origin.file.render(clip, codec)?);
        }
        let (channels, samples) = self.mixdown()?;
        let rate = self.project.sample_rate;
        match codec {
            Codec::Wav => {
                // The original's sample format when it is a WAV, else 24-bit.
                let like = self.origin.file.wav_format().unwrap_or(WavFormat {
                    channels,
                    sample_rate: rate,
                    bits: 24,
                    container_bytes: 3,
                    float: false,
                });
                let format = WavFormat {
                    channels,
                    sample_rate: rate,
                    ..like
                };
                let samples: Vec<f64> = samples.iter().map(|&x| x as f64).collect();
                Ok(encode_simple(format, &samples))
            }
            Codec::Mp3 => {
                let (kbps, tags) = match &*self.origin.file {
                    AudioFile::Mp3(f) => (f.kbps(), f.tags()),
                    AudioFile::Wav(_) => (mp3::DEFAULT_KBPS, Tags::default()),
                };
                let source = Source::new(channels, samples);
                let clip = Clip::new(Arc::new(source.clone()), 0);
                Ok(mp3::encode_clip(&source, &clip, rate, kbps, tags).map_err(FileError::from)?)
            }
        }
    }

    pub fn preview(&self) -> SavePreview {
        let fmt = self.format();
        let frames_before = self.origin.file.frames();
        let float = self.codec() == Codec::Wav && fmt.float;
        let peak_db = |peak: f64| {
            if peak > 0.0 {
                (20.0 * peak.log10()) as f32
            } else {
                f32::NEG_INFINITY
            }
        };
        let Some(c) = self.simple_clip() else {
            let (channels, samples) = self.mixdown().unwrap_or((2, Vec::new()));
            let peak = samples.iter().fold(0f64, |m, x| m.max(x.abs() as f64));
            return SavePreview {
                frames_before,
                frames_after: (samples.len() / channels as usize) as u64,
                cut_start: 0,
                cut_end: 0,
                peak_db: peak_db(peak),
                clipped: !float && peak > 1.0,
                untouched: false,
            };
        };
        let ch = c.source.channels() as usize;
        let s = c.source.samples();
        let mut peak = 0f64;
        for i in 0..c.len {
            let g = c.gain_at(i).abs();
            if g == 0.0 {
                continue;
            }
            let f = (c.offset + i) as usize * ch;
            for x in &s[f..f + ch] {
                peak = peak.max(*x as f64 * g);
                peak = peak.max(-*x as f64 * g);
            }
        }
        SavePreview {
            frames_before,
            frames_after: c.len,
            cut_start: c.offset,
            cut_end: frames_before - c.offset - c.len,
            peak_db: peak_db(peak),
            // Float WAV keeps overs; integer WAV and MP3 clip them.
            clipped: !float && peak > 1.0,
            untouched: c.offset == 0 && c.len == frames_before && c.is_unity(),
        }
    }

    /// Writes the edit over the original, keeping a backup in `backup_dir`.
    /// A simple edit then reopens the new file, so further edits start from
    /// what is on disk; a mixdown keeps the arrangement as it is.
    pub fn replace_original(&mut self, backup_dir: &Path) -> Result<Replaced, SessionSaveError> {
        let bytes = self.render_file(self.codec())?;
        let r = save::replace(
            &self.origin.path,
            &bytes,
            backup_dir,
            Some(self.origin.stamp),
        )?;
        if self.simple_clip().is_some() {
            self.reload_saved(bytes)?;
        } else {
            self.origin.stamp = FileStamp::of(&self.origin.path).map_err(SaveError::from)?;
            self.end_gesture();
            self.saved = self.project.clone();
        }
        Ok(r)
    }

    /// Writes the edit to a new file as `codec`. The session stays on the
    /// original.
    pub fn save_as_new(&self, path: &Path, codec: Codec) -> Result<(), SessionSaveError> {
        let bytes = self.render_file(codec)?;
        save::write_new(path, &bytes)?;
        Ok(())
    }

    fn reload_saved(&mut self, bytes: Vec<u8>) -> Result<(), SessionSaveError> {
        let stamp = FileStamp::of(&self.origin.path).map_err(SaveError::from)?;
        let file = AudioFile::parse(bytes)?;
        *self = Self::from_file(self.origin.path.clone(), file, stamp);
        Ok(())
    }
}

#[derive(Debug)]
pub enum SessionSaveError {
    Format(FileError),
    Save(SaveError),
    /// There are no clips to mix.
    Nothing,
}

impl SessionSaveError {
    pub fn kind(&self) -> &'static str {
        match self {
            SessionSaveError::Format(_) => "format",
            SessionSaveError::Save(e) => e.kind(),
            SessionSaveError::Nothing => "nothing",
        }
    }
}

impl fmt::Display for SessionSaveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SessionSaveError::Format(e) => write!(f, "{e}"),
            SessionSaveError::Save(e) => write!(f, "{e}"),
            SessionSaveError::Nothing => {
                write!(f, "there's nothing to hear: every clip is gone or muted")
            }
        }
    }
}

impl std::error::Error for SessionSaveError {}

impl From<FileError> for SessionSaveError {
    fn from(e: FileError) -> Self {
        SessionSaveError::Format(e)
    }
}

impl From<SaveError> for SessionSaveError {
    fn from(e: SaveError) -> Self {
        SessionSaveError::Save(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wav::encode_simple;

    /// The clip a session opens with: after its source (1) and track (2).
    const CLIP: u64 = 3;

    fn session(frames: usize) -> Session {
        let fmt = WavFormat {
            channels: 2,
            sample_rate: 44_100,
            bits: 24,
            container_bytes: 3,
            float: false,
        };
        let samples: Vec<f64> = (0..frames * 2)
            .map(|i| ((i % 100) as f64 - 50.0) / 100.0)
            .collect();
        let file = AudioFile::parse(encode_simple(fmt, &samples)).unwrap();
        Session::from_file(
            PathBuf::from("mem.wav"),
            file,
            FileStamp {
                len: 0,
                modified: None,
            },
        )
    }

    fn trim(offset: u64, len: u64) -> Command {
        Command::TrimClip {
            clip: CLIP,
            start: offset,
            offset,
            len,
        }
    }

    #[test]
    fn a_drag_is_one_undo_step() {
        let mut s = session(1000);
        for len in [900, 800, 700] {
            s.apply(&trim(0, len), true).unwrap();
        }
        s.end_gesture();
        assert_eq!(s.clip(CLIP).unwrap().len, 700);
        assert!(s.dirty());
        assert!(s.undo());
        assert_eq!(s.clip(CLIP).unwrap().len, 1000);
        assert!(!s.dirty());
        assert!(!s.undo());
        assert!(s.redo());
        assert_eq!(s.clip(CLIP).unwrap().len, 700);
    }

    #[test]
    fn a_drag_back_to_the_start_leaves_no_step() {
        let mut s = session(1000);
        s.apply(&trim(0, 900), true).unwrap();
        s.apply(&trim(0, 1000), true).unwrap();
        s.end_gesture();
        assert!(!s.state().can_undo);
        // A no-op command adds nothing either.
        s.apply(&trim(0, 1000), false).unwrap();
        assert!(!s.state().can_undo);
    }

    #[test]
    fn new_edits_clear_redo() {
        let mut s = session(1000);
        s.apply(&trim(10, 500), false).unwrap();
        s.undo();
        s.apply(
            &Command::SetClipGain {
                clip: CLIP,
                gain_db: -6.0,
            },
            false,
        )
        .unwrap();
        assert!(!s.state().can_redo);
    }

    #[test]
    fn preview_reports_the_cut_and_peak() {
        let mut s = session(1000);
        assert!(s.preview().untouched);
        s.apply(&trim(100, 600), false).unwrap();
        let p = s.preview();
        assert_eq!((p.cut_start, p.cut_end, p.frames_after), (100, 300, 600));
        assert!(!p.untouched);
        assert!((p.peak_db - 20.0 * 0.5f32.log10()).abs() < 0.01);
        s.apply(
            &Command::SetClipGain {
                clip: CLIP,
                gain_db: 12.0,
            },
            false,
        )
        .unwrap();
        assert!(s.preview().clipped);
    }

    #[test]
    fn where_the_clip_sits_does_not_change_the_saved_file() {
        let mut s = session(1000);
        s.apply(&trim(250, 500), false).unwrap();
        let in_place = s.render_file(Codec::Wav).unwrap();
        // Slide the trimmed clip back to the start of the timeline.
        s.apply(
            &Command::TrimClip {
                clip: CLIP,
                start: 0,
                offset: 250,
                len: 500,
            },
            false,
        )
        .unwrap();
        assert_eq!(s.clip(CLIP).unwrap().start, 0);
        assert_eq!(s.render_file(Codec::Wav).unwrap(), in_place);
        assert_eq!(s.preview().frames_after, 500);
    }

    #[test]
    fn replace_writes_reopens_and_backs_up() {
        let dir = std::env::temp_dir().join(format!("dawg-session-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("kick.wav");
        let original = session(1000).origin.file.bytes().to_vec();
        fs::write(&path, &original).unwrap();

        let mut s = Session::open(&path).unwrap();
        s.apply(&trim(250, 500), false).unwrap();
        let r = s.replace_original(&dir.join("backups")).unwrap();
        assert_eq!(fs::read(&r.backup).unwrap(), original);
        assert_eq!(s.state().frames, 500);
        assert!(!s.dirty());
        assert!(!s.state().can_undo);

        // Saving the reopened file untouched as a new file is bit-identical.
        let copy = dir.join("copy.wav");
        s.save_as_new(&copy, Codec::Wav).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), fs::read(&path).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mp3_saves_over_itself_and_exports_wav() {
        let dir = std::env::temp_dir().join(format!("dawg-session-mp3-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("loop.mp3");
        let wav = session(30_000);
        fs::write(&path, wav.render_file(Codec::Mp3).unwrap()).unwrap();

        let mut s = Session::open(&path).unwrap();
        assert_eq!(s.state().codec, Codec::Mp3);
        assert_eq!(s.state().frames, 30_000);
        for len in [20_000, 15_000] {
            s.apply(&trim(1000, len), false).unwrap();
            s.replace_original(&dir.join("backups")).unwrap();
            assert_eq!(s.state().frames, len, "no frames gained or lost");
        }
        let out = dir.join("loop.wav");
        s.save_as_new(&out, Codec::Wav).unwrap();
        let w = Session::open(&out).unwrap().state();
        assert_eq!((w.codec, w.frames, w.format.bits), (Codec::Wav, 15_000, 24));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A temp folder for one test.
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dawg-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_wav(path: &Path, channels: u16, rate: u32, frames: usize, value: f64) {
        let fmt = WavFormat {
            channels,
            sample_rate: rate,
            bits: 24,
            container_bytes: 3,
            float: false,
        };
        let samples = vec![value; frames * channels as usize];
        fs::write(path, encode_simple(fmt, &samples)).unwrap();
    }

    #[test]
    fn added_files_get_their_own_tracks_at_the_session_rate() {
        let dir = temp_dir("import");
        let a = dir.join("a.wav");
        let b = dir.join("b.wav");
        write_wav(&a, 2, 48_000, 4800, 0.25);
        let mut s = session(1000);
        let r = s
            .import(
                &[a.clone(), dir.join("missing.wav"), b.clone()],
                Placement {
                    track: None,
                    start: 100,
                },
            )
            .unwrap();
        // b.wav doesn't exist yet either.
        assert_eq!((r.clips.len(), r.failed.len()), (1, 2));
        write_wav(&b, 1, 44_100, 441, 0.5);
        let r2 = s
            .import(
                &[b],
                Placement {
                    track: Some(s.project().tracks[1].id),
                    start: 0,
                },
            )
            .unwrap();
        let st = s.state();
        assert_eq!(st.tracks.len(), 2);
        assert_eq!(st.tracks[1].name, "a");
        let added = s.clip(r.clips[0]).unwrap();
        // 4800 frames at 48 kHz are 4410 at the session's 44.1 kHz.
        assert_eq!((added.start, added.len), (100, 4410));
        assert_eq!(s.clip(r2.clips[0]).unwrap().len, 441);
        assert!(!st.simple);
        assert_eq!((st.start, st.end), (0, 4510));
        // One undo step per import.
        assert!(s.undo());
        assert_eq!(s.project().tracks[1].clips.len(), 1);
        assert!(s.undo());
        assert_eq!(s.project().tracks.len(), 1);
        assert!(s.state().simple);
        assert!(s.source(r.clips[0] - 2).is_some(), "sources outlive undo");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_mixdown_runs_from_the_first_clip_to_the_last() {
        let dir = temp_dir("mixdown");
        let a = dir.join("a.wav");
        write_wav(&a, 1, 44_100, 500, 0.25);
        let mut s = session(1000);
        // Trim the original's head and leave a gap before it.
        s.apply(
            &Command::TrimClip {
                clip: CLIP,
                start: 300,
                offset: 100,
                len: 600,
            },
            false,
        )
        .unwrap();
        s.import(
            &[a],
            Placement {
                track: None,
                start: 2000,
            },
        )
        .unwrap();
        let mix = AudioFile::parse(s.render_file(Codec::Wav).unwrap()).unwrap();
        // 300..900 for the original, a gap, then 2000..2500.
        assert_eq!(mix.frames(), 2200);
        let f = mix.wav_format().unwrap();
        assert_eq!((f.channels, f.sample_rate, f.bits), (2, 44_100, 24));
        let src = mix.decode();
        let at = |frame: usize| src.samples()[frame * 2];
        assert!((at(0) - s.clip(CLIP).unwrap().source.samples()[200]).abs() < 1e-5);
        assert_eq!(at(1000), 0.0);
        assert!((at(1800) - 0.25).abs() < 1e-5);

        // Muting the original's track leaves the other clip, now mono.
        let t = s.project().tracks[0].id;
        s.apply(
            &Command::SetTrackMix {
                track: t,
                gain_db: None,
                pan: None,
                muted: Some(true),
                solo: None,
            },
            false,
        )
        .unwrap();
        let mix = AudioFile::parse(s.render_file(Codec::Mp3).unwrap()).unwrap();
        // ...and no longer starts with the muted clip's stretch of silence.
        assert_eq!((mix.channels(), mix.frames()), (1, 500));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replacing_with_a_mix_keeps_the_arrangement() {
        let dir = temp_dir("replace-mix");
        let path = dir.join("kick.wav");
        let a = dir.join("a.wav");
        fs::write(&path, session(1000).origin.file.bytes()).unwrap();
        write_wav(&a, 2, 44_100, 2000, 0.1);
        let mut s = Session::open(&path).unwrap();
        s.import(&[a], Placement::default()).unwrap();
        s.replace_original(&dir.join("backups")).unwrap();
        let st = s.state();
        assert_eq!(st.tracks.len(), 2);
        assert!(!st.dirty);
        assert_eq!(
            AudioFile::parse(fs::read(&path).unwrap()).unwrap().frames(),
            2000
        );
        // A second replace sees the new file on disk as ours.
        s.apply(&Command::DeleteClip { clip: CLIP }, false).unwrap();
        s.replace_original(&dir.join("backups")).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_session_has_nothing_to_export() {
        let mut s = session(1000);
        s.apply(&Command::DeleteClip { clip: CLIP }, false).unwrap();
        assert!(matches!(
            s.render_file(Codec::Wav),
            Err(SessionSaveError::Nothing)
        ));
    }
}
