//! An editing session: the "Edit in dawg" scratch session, widened to many
//! tracks, or a project.
//!
//! A scratch session is opened from an audio file, which becomes one clip on
//! one track at its own sample rate. A project is opened from a `.dawg` file
//! (see [`crate::project_file`]) or starts empty; saving a scratch session
//! as a project turns it into one. More files can be added onto other
//! tracks; they are converted to the session's rate. Edits are [`Command`]s; every committed edit is one
//! undo step, and a drag sends transient commands that collapse into one step
//! when it ends.
//!
//! Export has two paths. While a scratch session is still just the original
//! file's clip, saving keeps that file's own format and untouched bytes
//! ([`AudioFile::render`]). Anything more is a mixdown through the renderer,
//! from the first clip's start to the last clip's end.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::command::{fit_fades, gain_to_db, Command, CommandError};
use crate::eq::{Eq, EqBand};
use crate::file::{AudioFile, Codec, FileError};
use crate::model::{Clip, EnvPoint, FadeCurve, Project, Source, Track};
use crate::mp3::{self, Tags};
use crate::peaks::Peaks;
use crate::project_file::{ProjectError, ProjectFile, EXTENSION};
use crate::render::{render, OUT_CHANNELS};
use crate::resample::resample;
use crate::save::{self, FileStamp, Replaced, SaveError};
use crate::stretch::{MAX_PITCH, MAX_STRETCH, MIN_STRETCH};
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
    /// A project's file that wasn't found: the source is silence of the
    /// length it had.
    missing: bool,
}

impl SourceInfo {
    fn new(path: PathBuf, source: Arc<Source>, rate: u32) -> Self {
        SourceInfo {
            path,
            peaks: Peaks::new(&source),
            source,
            rate,
            missing: false,
        }
    }
}

/// Default rate of a new project; the first file added sets the real one.
pub const PROJECT_RATE: u32 = 48_000;

pub struct Session {
    /// The audio file a scratch session edits; `None` for a project.
    origin: Option<Origin>,
    /// Where the project is saved; `None` until it is, and for scratch.
    project_path: Option<PathBuf>,
    sources: BTreeMap<u64, SourceInfo>,
    project: Arc<Project>,
    /// The state that matches the file on disk.
    saved: Arc<Project>,
    /// The state before each edit, oldest first, named after that edit.
    undo: Vec<Step>,
    /// Undone edits, the next to redo last; each holds the state after it.
    redo: Vec<Step>,
    /// A drag is under way; its first transient command took the undo step.
    in_gesture: bool,
}

/// Choices in the Export dialog. Every field left out keeps what a plain
/// export does.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// Timeline frames to mix, start and end; by default from the first
    /// clip heard to the end of the last.
    #[serde(default)]
    pub range: Option<(u64, u64)>,
    /// WAV depth: 16, 24 or 32 (float).
    #[serde(default)]
    pub bits: Option<u16>,
    /// Sample rate of the file, converted from the session's.
    #[serde(default)]
    pub rate: Option<u32>,
    /// MP3 bitrate.
    #[serde(default)]
    pub kbps: Option<u32>,
}

impl ExportOptions {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// One entry of the undo or redo list.
#[derive(Clone)]
struct Step {
    project: Arc<Project>,
    label: String,
    /// When the edit was made, in ms since the Unix epoch.
    at: u64,
}

/// An edit in the history, for the History panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub label: String,
    /// When it was made, in ms since the Unix epoch.
    pub at: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// What the UI shows about the session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    /// A scratch session (an audio file being edited) rather than a project.
    pub scratch: bool,
    /// The audio file a scratch session edits.
    pub path: Option<PathBuf>,
    /// The project's `.dawg` file, once saved.
    pub project: Option<PathBuf>,
    /// The file name to show: the audio file's, the project's, or
    /// "Untitled".
    pub name: String,
    /// The audio file's format; for a project, what a mixdown defaults to.
    pub codec: Codec,
    /// Sample layout of that file. For MP3, `bits` and `container_bytes` are
    /// 0.
    pub format: WavFormat,
    /// MP3 average bitrate in kbps.
    pub kbps: Option<u32>,
    /// Frames in that file; 0 for a project.
    pub frames: u64,
    /// The session's sample rate; every source plays at it.
    pub rate: u32,
    pub tracks: Vec<TrackState>,
    /// Master volume.
    pub master_db: f32,
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
    /// Edits that can be undone, oldest first.
    pub history: Vec<HistoryEntry>,
    /// Undone edits that can be redone, the next one first.
    pub future: Vec<HistoryEntry>,
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
    pub eq: Vec<EqBand>,
    pub eq_bypass: bool,
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
    /// Timeline frames per source frame.
    pub stretch: f64,
    /// Semitones.
    pub pitch: f32,
    pub fade_in_curve: FadeCurve,
    pub fade_out_curve: FadeCurve,
    pub reversed: bool,
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
    /// The project's file wasn't found; its clips play silence.
    pub missing: bool,
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

/// Whether `path` names a project file rather than audio.
pub fn is_project(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION))
}

/// Keeps a clip inside its source, for a file that changed length.
fn fit_to_source(clip: &mut Clip) {
    let frames = clip.source.frames();
    clip.offset = clip.offset.min(frames.saturating_sub(1));
    clip.len = clip.len.clamp(1, clip.max_len(clip.offset).max(1));
    fit_fades(clip);
}

/// `p` with `source` in place of the source of the same id, in the pool and
/// under every clip that plays it.
fn with_source(p: &Project, source: &Arc<Source>) -> Project {
    let mut p = p.clone();
    let id = source.id();
    for s in p.sources.iter_mut().filter(|s| s.id() == id) {
        *s = source.clone();
    }
    let rate = p.sample_rate;
    let mut done: Vec<Clip> = Vec::new();
    for t in &mut p.tracks {
        for c in t.clips.iter_mut().filter(|c| c.source.id() == id) {
            c.source = source.clone();
            fit_to_source(c);
            let like = done
                .iter()
                .find(|d| d.stretch == c.stretch && d.pitch == c.pitch && d.reversed == c.reversed);
            c.retime(rate, like);
            if c.retimed() {
                done.push(c.clone());
            }
        }
    }
    p
}

impl Step {
    fn entry(&self) -> HistoryEntry {
        HistoryEntry {
            label: self.label.clone(),
            at: self.at,
        }
    }
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
        sources.insert(source_id, SourceInfo::new(path.clone(), source, rate));
        let project = Arc::new(project);
        Session {
            origin: Some(Origin {
                path,
                file: Arc::new(file),
                stamp,
                source: source_id,
            }),
            project_path: None,
            sources,
            saved: project.clone(),
            project,
            undo: Vec::new(),
            redo: Vec::new(),
            in_gesture: false,
        }
    }

    /// An empty, unsaved project.
    pub fn new_project() -> Session {
        Self::from_project(Project::new(PROJECT_RATE), BTreeMap::new(), None)
    }

    fn from_project(
        project: Project,
        sources: BTreeMap<u64, SourceInfo>,
        path: Option<PathBuf>,
    ) -> Session {
        let project = Arc::new(project);
        Session {
            origin: None,
            project_path: path,
            sources,
            saved: project.clone(),
            project,
            undo: Vec::new(),
            redo: Vec::new(),
            in_gesture: false,
        }
    }

    /// Opens a `.dawg` project. Audio files that can't be found or read
    /// open as silence of their old length, marked missing (see
    /// [`Session::relink`]).
    pub fn open_project(path: &Path) -> Result<Session, ProjectError> {
        let file = ProjectFile::parse(&fs::read(path)?)?;
        let rate = file.sample_rate;
        let mut project = Project::new(rate);
        let mut sources = BTreeMap::new();
        for entry in &file.sources {
            let candidates = file.candidates(entry, path);
            let found = candidates
                .iter()
                .find_map(|p| read_file(p).ok().map(|(f, _)| (p.clone(), f)));
            let info = match found {
                Some((p, f)) => {
                    let own = f.sample_rate();
                    let source = resample(&f.decode(), own, rate).with_id(entry.id);
                    SourceInfo::new(p, Arc::new(source), own)
                }
                None => {
                    let channels = entry.channels.max(1);
                    let silence = vec![0.0; entry.frames.max(1) as usize * channels as usize];
                    let source = Source::new(channels, silence).with_id(entry.id);
                    SourceInfo {
                        missing: true,
                        ..SourceInfo::new(candidates[0].clone(), Arc::new(source), entry.rate)
                    }
                }
            };
            project.sources.push(info.source.clone());
            sources.insert(entry.id, info);
        }
        let mut top = file.next_id;
        // Clips that share a source, stretch and pitch share their audio.
        let mut retimed: Vec<Clip> = Vec::new();
        for t in &file.tracks {
            top = top.max(t.id + 1);
            let mut clips = Vec::with_capacity(t.clips.len());
            for c in &t.clips {
                top = top.max(c.id + 1);
                let source = sources
                    .get(&c.source)
                    .map(|s| s.source.clone())
                    .ok_or_else(|| {
                        ProjectError::Invalid(format!(
                            "clip {} uses unknown source {}",
                            c.id, c.source
                        ))
                    })?;
                let mut envelope = c.envelope.clone();
                envelope.sort_by_key(|p| p.at);
                let mut clip = Clip {
                    id: c.id,
                    source,
                    start: c.start,
                    offset: c.offset,
                    len: c.len,
                    gain: c.gain,
                    fade_in: c.fade_in,
                    fade_out: c.fade_out,
                    fade_in_curve: c.fade_in_curve,
                    fade_out_curve: c.fade_out_curve,
                    reversed: c.reversed,
                    envelope: envelope.into(),
                    stretch: if c.stretch.is_finite() {
                        c.stretch.clamp(MIN_STRETCH, MAX_STRETCH)
                    } else {
                        1.0
                    },
                    pitch: if c.pitch.is_finite() {
                        c.pitch.clamp(-MAX_PITCH, MAX_PITCH)
                    } else {
                        0.0
                    },
                    audio: None,
                };
                fit_to_source(&mut clip);
                let like = retimed.iter().find(|r| {
                    Arc::ptr_eq(&r.source, &clip.source)
                        && r.stretch == clip.stretch
                        && r.pitch == clip.pitch
                        && r.reversed == clip.reversed
                });
                clip.retime(rate, like);
                if clip.retimed() {
                    retimed.push(clip.clone());
                }
                clips.push(clip);
            }
            project.tracks.push(Track {
                id: t.id,
                name: t.name.clone(),
                clips,
                gain: t.gain,
                pan: t.pan,
                muted: t.muted,
                solo: t.solo,
                eq: Eq::new(&t.eq, t.eq_bypass, rate),
            });
        }
        for s in &file.sources {
            top = top.max(s.id + 1);
        }
        project.next_id = top;
        project.master_gain = if file.master_gain.is_finite() {
            file.master_gain.clamp(0.0, 4.0)
        } else {
            1.0
        };
        Ok(Self::from_project(
            project,
            sources,
            Some(path.to_path_buf()),
        ))
    }

    /// Saves the session as a project at `path`, new or over the last save.
    /// A scratch session becomes a project: from here on its export is a
    /// mixdown and its original file is just one of its sources.
    pub fn save_project(&mut self, path: &Path) -> Result<(), SaveError> {
        self.end_gesture();
        let file = ProjectFile::from_project(&self.project, path, |id| {
            self.sources.get(&id).map(|s| (s.path.clone(), s.rate))
        });
        save::overwrite(path, &file.to_json())?;
        self.origin = None;
        self.project_path = Some(path.to_path_buf());
        self.saved = self.project.clone();
        Ok(())
    }

    /// Points a source at another file (a missing one, found). Any other
    /// missing files with the same name in that folder are found too. Not an
    /// undo step; the project needs saving afterwards. Returns how many
    /// sources were relinked.
    pub fn relink(&mut self, source: u64, path: &Path) -> Result<usize, OpenError> {
        self.end_gesture();
        if !self.sources.contains_key(&source) {
            return Err(OpenError::Io(io::Error::new(
                io::ErrorKind::NotFound,
                format!("no source {source}"),
            )));
        }
        let mut found = vec![(source, path.to_path_buf())];
        let dir = path.parent().unwrap_or(Path::new(""));
        for (&id, s) in &self.sources {
            if id != source && s.missing {
                if let Some(name) = s.path.file_name() {
                    let there = dir.join(name);
                    if there.is_file() {
                        found.push((id, there));
                    }
                }
            }
        }
        let mut n = 0;
        for (id, p) in found {
            let (file, _) = match read_file(&p) {
                Ok(f) => f,
                // The one asked for must work; the others are a bonus.
                Err(e) if id == source => return Err(e),
                Err(_) => continue,
            };
            let rate = file.sample_rate();
            let audio =
                Arc::new(resample(&file.decode(), rate, self.project.sample_rate).with_id(id));
            let swap = |p: &Arc<Project>| Arc::new(with_source(p, &audio));
            self.project = swap(&self.project);
            for s in self.undo.iter_mut().chain(self.redo.iter_mut()) {
                s.project = swap(&s.project);
            }
            self.sources.insert(id, SourceInfo::new(p, audio, rate));
            n += 1;
        }
        Ok(n)
    }

    /// The audio file a scratch session edits.
    pub fn path(&self) -> Option<&Path> {
        self.origin.as_ref().map(|o| o.path.as_path())
    }

    /// Where the project is saved.
    pub fn project_path(&self) -> Option<&Path> {
        self.project_path.as_deref()
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
        let origin = self.origin.as_ref()?;
        let p = &self.project;
        let mut clips = p.clips();
        let (track, clip) = clips.next()?;
        let alone = clips.next().is_none();
        (alone
            && clip.source.id() == origin.source
            && !clip.retimed()
            && !track.eq.active()
            && p.master_gain == 1.0
            && track.gain == 1.0
            && track.pan == 0.0
            && p.audible(track))
        .then_some(clip)
    }

    pub fn state(&self) -> SessionState {
        let p = &self.project;
        let o = self.origin.as_ref();
        let name = match (o, &self.project_path) {
            (Some(o), _) => file_name(&o.path),
            (None, Some(path)) => file_name(path),
            (None, None) => "Untitled".into(),
        };
        SessionState {
            scratch: o.is_some(),
            path: o.map(|o| o.path.clone()),
            project: self.project_path.clone(),
            name,
            codec: self.codec(),
            format: self.format(),
            kbps: o.and_then(|o| o.file.kbps()),
            frames: o.map_or(0, |o| o.file.frames()),
            rate: p.sample_rate,
            master_db: gain_to_db(p.master_gain),
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
                    eq: t.eq.bands().to_vec(),
                    eq_bypass: t.eq.bypass(),
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
                            stretch: c.stretch,
                            pitch: c.pitch,
                            fade_in_curve: c.fade_in_curve,
                            fade_out_curve: c.fade_out_curve,
                            reversed: c.reversed,
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
                    missing: s.missing,
                })
                .collect(),
            start: p.audible_span().map_or(0, |s| s.0),
            end: p.audible_span().map_or(0, |s| s.1),
            simple: self.simple_clip().is_some(),
            dirty: self.dirty(),
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            history: self.undo.iter().map(Step::entry).collect(),
            future: self.redo.iter().rev().map(Step::entry).collect(),
            extra_chunks: o.map_or_else(Vec::new, |o| o.file.extra_chunks()),
            truncated: o.is_some_and(|o| o.file.truncated()),
        }
    }

    /// Applies `cmd`. A `transient` command is part of a drag: the first one
    /// records the undo step and the rest replace the live state until
    /// [`Session::end_gesture`].
    pub fn apply(&mut self, cmd: &Command, transient: bool) -> Result<(), CommandError> {
        let next = cmd.apply(&self.project)?;
        self.commit(next, transient, cmd.label());
        Ok(())
    }

    fn commit(&mut self, next: Project, transient: bool, label: String) {
        if !self.in_gesture {
            if next.same_edit(&self.project) {
                return;
            }
            self.push_undo(label);
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
        if self
            .undo
            .last()
            .is_some_and(|s| s.project.same_edit(&self.project))
        {
            self.undo.pop();
        }
    }

    fn push_undo(&mut self, label: String) {
        self.undo.push(Step {
            project: self.project.clone(),
            label,
            at: now_ms(),
        });
        if self.undo.len() > HISTORY {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    pub fn undo(&mut self) -> bool {
        self.end_gesture();
        let Some(s) = self.undo.pop() else {
            return false;
        };
        let after = std::mem::replace(&mut self.project, s.project);
        self.redo.push(Step {
            project: after,
            ..s
        });
        true
    }

    pub fn redo(&mut self) -> bool {
        self.end_gesture();
        let Some(s) = self.redo.pop() else {
            return false;
        };
        let before = std::mem::replace(&mut self.project, s.project);
        self.undo.push(Step {
            project: before,
            ..s
        });
        true
    }

    /// Undoes or redoes until `done` edits of the history are applied, as a
    /// click on a History row does. Returns false when `done` is out of range.
    pub fn jump(&mut self, done: usize) -> bool {
        self.end_gesture();
        if done > self.undo.len() + self.redo.len() {
            return false;
        }
        while self.undo.len() > done {
            self.undo();
        }
        while self.undo.len() < done {
            self.redo();
        }
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
            // A new project takes the rate of the first file put in it.
            if self.origin.is_none() && p.sources.is_empty() && p.clips().next().is_none() {
                p.sample_rate = rate;
                for t in &mut p.tracks {
                    t.eq = t.eq.at_rate(rate);
                }
            }
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
            self.sources
                .insert(id, SourceInfo::new(path.clone(), source, rate));
        }
        if !out.clips.is_empty() {
            let label = match out.clips.len() {
                1 => "Add file".to_string(),
                n => format!("Add {n} files"),
            };
            self.commit(p, false, label);
        }
        Ok(out)
    }

    /// The format of the file being edited; WAV for a project.
    pub fn codec(&self) -> Codec {
        self.origin.as_ref().map_or(Codec::Wav, |o| o.file.codec())
    }

    fn format(&self) -> WavFormat {
        let Some(o) = &self.origin else {
            return WavFormat {
                channels: OUT_CHANNELS as u16,
                sample_rate: self.project.sample_rate,
                bits: 24,
                container_bytes: 3,
                float: false,
            };
        };
        let f = &o.file;
        f.wav_format().unwrap_or(WavFormat {
            channels: f.channels(),
            sample_rate: f.sample_rate(),
            bits: 0,
            container_bytes: 0,
            float: false,
        })
    }

    /// The mixdown, interleaved, over `range` (timeline frames) or from the
    /// first clip heard to the end of the last: stereo, or mono when
    /// everything heard is mono and centred.
    fn mixdown(&self, range: Option<(u64, u64)>) -> Result<(u16, Vec<f32>), SessionSaveError> {
        let p = &self.project;
        let (start, end) = match range {
            Some((a, b)) if b > a => (a, b),
            Some(_) => return Err(SessionSaveError::Nothing),
            None => p.audible_span().ok_or(SessionSaveError::Nothing)?,
        };
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
        self.render_with(codec, &ExportOptions::default())
    }

    /// The file an export with `opts` would write, as `codec`. With no
    /// options, a scratch file's own clip saves in its own format, untouched
    /// bytes and all; anything else is a mixdown.
    pub fn render_with(
        &self,
        codec: Codec,
        opts: &ExportOptions,
    ) -> Result<Vec<u8>, SessionSaveError> {
        if opts.is_default() {
            if let (Some(clip), Some(o)) = (self.simple_clip(), &self.origin) {
                return Ok(o.file.render(clip, codec)?);
            }
        }
        let original = self.origin.as_ref().map(|o| &*o.file);
        let (channels, mut samples) = self.mixdown(opts.range)?;
        let mut rate = self.project.sample_rate;
        if let Some(to) = opts.rate.filter(|&r| r != rate) {
            if !(8_000..=192_000).contains(&to) {
                return Err(SessionSaveError::Options(format!(
                    "can't export at {to} Hz"
                )));
            }
            let src = resample(&Source::new(channels, samples), rate, to);
            samples = src.samples().to_vec();
            rate = to;
        }
        match codec {
            Codec::Wav => {
                // The chosen depth; else the original's sample format when
                // it is a WAV, else 24-bit.
                let like = match opts.bits {
                    Some(16) => WavFormat {
                        channels,
                        sample_rate: rate,
                        bits: 16,
                        container_bytes: 2,
                        float: false,
                    },
                    Some(24) => WavFormat {
                        channels,
                        sample_rate: rate,
                        bits: 24,
                        container_bytes: 3,
                        float: false,
                    },
                    Some(32) => WavFormat {
                        channels,
                        sample_rate: rate,
                        bits: 32,
                        container_bytes: 4,
                        float: true,
                    },
                    Some(b) => {
                        return Err(SessionSaveError::Options(format!(
                            "{b}-bit WAV isn't offered; pick 16, 24 or 32 (float)"
                        )))
                    }
                    None => original.and_then(|f| f.wav_format()).unwrap_or(WavFormat {
                        channels,
                        sample_rate: rate,
                        bits: 24,
                        container_bytes: 3,
                        float: false,
                    }),
                };
                let format = WavFormat {
                    channels,
                    sample_rate: rate,
                    ..like
                };
                let samples: Vec<f64> = samples.iter().map(|&x| x as f64).collect();
                Ok(encode_simple(format, &samples))
            }
            Codec::Mp3 => {
                let (kbps, tags) = match original {
                    Some(AudioFile::Mp3(f)) => (f.kbps(), f.tags()),
                    _ => (mp3::DEFAULT_KBPS, Tags::default()),
                };
                let kbps = opts.kbps.unwrap_or(kbps);
                let source = Source::new(channels, samples);
                let clip = Clip::new(Arc::new(source.clone()), 0);
                Ok(mp3::encode_clip(&source, &clip, rate, kbps, tags).map_err(FileError::from)?)
            }
        }
    }

    /// Loudest sample of the mixdown over `range` (or every clip heard), in
    /// dBFS; `None` when it is silent or there is nothing to mix.
    pub fn mix_peak(&self, range: Option<(u64, u64)>) -> Option<f32> {
        let (_, samples) = self.mixdown(range).ok()?;
        let peak = samples.iter().fold(0f32, |m, x| m.max(x.abs()));
        (peak > 0.0).then(|| 20.0 * peak.log10())
    }

    pub fn preview(&self) -> SavePreview {
        let fmt = self.format();
        let frames_before = self.origin.as_ref().map_or(0, |o| o.file.frames());
        let float = self.codec() == Codec::Wav && fmt.float;
        let peak_db = |peak: f64| {
            if peak > 0.0 {
                (20.0 * peak.log10()) as f32
            } else {
                f32::NEG_INFINITY
            }
        };
        let Some(c) = self.simple_clip() else {
            let (channels, samples) = self.mixdown(None).unwrap_or((2, Vec::new()));
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
        let Some(o) = &self.origin else {
            return Err(SessionSaveError::NoOriginal);
        };
        let bytes = self.render_file(self.codec())?;
        let r = save::replace(&o.path, &bytes, backup_dir, Some(o.stamp))?;
        if self.simple_clip().is_some() {
            self.reload_saved(bytes)?;
        } else if let Some(o) = &mut self.origin {
            o.stamp = FileStamp::of(&o.path).map_err(SaveError::from)?;
            self.end_gesture();
            self.saved = self.project.clone();
        }
        Ok(r)
    }

    /// Writes the edit to a new file as `codec`. The session stays on the
    /// original.
    pub fn save_as_new(&self, path: &Path, codec: Codec) -> Result<(), SessionSaveError> {
        self.export_new(path, codec, &ExportOptions::default())
    }

    /// Writes a new file with `opts`; see [`Session::render_with`].
    pub fn export_new(
        &self,
        path: &Path,
        codec: Codec,
        opts: &ExportOptions,
    ) -> Result<(), SessionSaveError> {
        let bytes = self.render_with(codec, opts)?;
        save::write_new(path, &bytes)?;
        Ok(())
    }

    fn reload_saved(&mut self, bytes: Vec<u8>) -> Result<(), SessionSaveError> {
        let path = self
            .path()
            .ok_or(SessionSaveError::NoOriginal)?
            .to_path_buf();
        let stamp = FileStamp::of(&path).map_err(SaveError::from)?;
        let file = AudioFile::parse(bytes)?;
        *self = Self::from_file(path, file, stamp);
        Ok(())
    }
}

#[derive(Debug)]
pub enum SessionSaveError {
    Format(FileError),
    Save(SaveError),
    /// There are no clips to mix.
    Nothing,
    /// A project has no original file to replace.
    NoOriginal,
    /// Export options that can't be met.
    Options(String),
}

impl SessionSaveError {
    pub fn kind(&self) -> &'static str {
        match self {
            SessionSaveError::Format(_) => "format",
            SessionSaveError::Save(e) => e.kind(),
            SessionSaveError::Nothing => "nothing",
            SessionSaveError::NoOriginal => "no_original",
            SessionSaveError::Options(_) => "options",
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
            SessionSaveError::Options(m) => write!(f, "{m}"),
            SessionSaveError::NoOriginal => {
                write!(
                    f,
                    "a project has no original file to replace; export it instead"
                )
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
    fn history_names_each_step_and_jumps() {
        let mut s = session(1000);
        s.apply(&trim(0, 900), false).unwrap();
        s.apply(
            &Command::SetClipGain {
                clip: CLIP,
                gain_db: -6.0,
            },
            false,
        )
        .unwrap();
        s.apply(
            &Command::Batch {
                label: Some("Envelope: Swell".into()),
                commands: vec![],
            },
            false,
        )
        .unwrap();
        s.apply(
            &Command::Batch {
                label: None,
                commands: vec![trim(0, 800), trim(0, 700)],
            },
            false,
        )
        .unwrap();
        let labels = |v: &[HistoryEntry]| v.iter().map(|e| e.label.clone()).collect::<Vec<_>>();
        // The empty batch changed nothing, so it isn't a step.
        assert_eq!(
            labels(&s.state().history),
            ["Trim clip", "Clip gain", "Trim clip ×2"]
        );
        assert!(s.jump(1));
        let st = s.state();
        assert_eq!(s.clip(CLIP).unwrap().len, 900);
        assert_eq!(labels(&st.history), ["Trim clip"]);
        assert_eq!(labels(&st.future), ["Clip gain", "Trim clip ×2"]);
        assert!(s.jump(3));
        assert_eq!(s.clip(CLIP).unwrap().len, 700);
        assert!(!s.jump(4));
        assert!(s.jump(0));
        assert!(!s.dirty());
    }

    #[test]
    fn export_options_pick_range_depth_and_rate() {
        // 1000 frames at 44.1 kHz, 24-bit stereo.
        let s = session(1000);
        let opts = ExportOptions {
            range: Some((100, 600)),
            bits: Some(16),
            rate: Some(22_050),
            kbps: None,
        };
        let f = AudioFile::parse(s.render_with(Codec::Wav, &opts).unwrap()).unwrap();
        let w = f.wav_format().unwrap();
        assert_eq!(
            (w.bits, w.float, w.sample_rate, w.channels),
            (16, false, 22_050, 2)
        );
        assert_eq!(f.frames(), 250);
        let float = ExportOptions {
            bits: Some(32),
            ..Default::default()
        };
        let f = AudioFile::parse(s.render_with(Codec::Wav, &float).unwrap()).unwrap();
        assert!(f.wav_format().unwrap().float);
        assert_eq!(f.frames(), 1000);
        // Plain options save the original's bytes as before.
        assert_eq!(
            s.render_with(Codec::Wav, &ExportOptions::default())
                .unwrap(),
            s.render_file(Codec::Wav).unwrap()
        );
        assert!(matches!(
            s.render_with(
                Codec::Wav,
                &ExportOptions {
                    bits: Some(20),
                    ..Default::default()
                }
            ),
            Err(SessionSaveError::Options(_))
        ));
        // The test signal peaks at 0.5.
        let peak = s.mix_peak(None).unwrap();
        assert!((peak + 6.02).abs() < 0.05, "{peak}");
        assert_eq!(s.mix_peak(Some((5, 5))), None);
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
        let original = session(1000).origin.unwrap().file.bytes().to_vec();
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
        fs::write(&path, session(1000).origin.unwrap().file.bytes()).unwrap();
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

    #[test]
    fn a_project_saves_and_reopens_as_it_was() {
        let dir = temp_dir("project");
        let path = dir.join("kick.wav");
        let a = dir.join("Samples").join("a.wav");
        fs::create_dir_all(a.parent().unwrap()).unwrap();
        fs::write(&path, session(1000).origin.unwrap().file.bytes()).unwrap();
        write_wav(&a, 1, 48_000, 960, 0.25);

        let mut s = Session::open(&path).unwrap();
        s.apply(&trim(100, 600), false).unwrap();
        s.import(&[a], Placement::default()).unwrap();
        let t = s.project().tracks[1].id;
        let t0 = s.project().tracks[0].id;
        s.apply(
            &Command::Batch {
                label: None,
                commands: vec![
                    Command::StretchClip {
                        clip: CLIP,
                        stretch: 1.5,
                        start: None,
                    },
                    Command::SetClipPitch {
                        clip: CLIP,
                        semitones: -3.5,
                    },
                    Command::SetTrackEq {
                        track: t0,
                        bands: vec![EqBand {
                            kind: crate::eq::BandKind::Bell,
                            freq: 800.0,
                            gain_db: 4.0,
                            q: 2.0,
                            slope: 12,
                            on: true,
                        }],
                        bypass: None,
                    },
                    Command::SetTrackMix {
                        track: t,
                        gain_db: Some(-3.0),
                        pan: Some(-0.25),
                        muted: Some(true),
                        solo: None,
                    },
                    Command::SetClipFades {
                        clip: CLIP,
                        fade_in: 10,
                        fade_out: 20,
                        curve_in: Some(FadeCurve::Exp),
                        curve_out: Some(FadeCurve::S),
                    },
                    Command::ReverseClip {
                        clip: CLIP,
                        reversed: true,
                    },
                    Command::SetMasterGain { gain_db: -2.0 },
                    Command::SetClipGain {
                        clip: CLIP,
                        gain_db: -1.5,
                    },
                    Command::SetEnvelope {
                        clip: CLIP,
                        points: vec![
                            EnvPoint { at: 150, gain: 1.0 },
                            EnvPoint { at: 500, gain: 0.3 },
                        ],
                    },
                ],
            },
            false,
        )
        .unwrap();
        let mix = s.render_file(Codec::Wav).unwrap();
        assert!(s.state().scratch);

        let song = dir.join("song.dawg");
        s.save_project(&song).unwrap();
        let st = s.state();
        assert!(!st.scratch && !st.dirty);
        assert_eq!(
            (st.name.as_str(), st.path, st.project),
            ("song.dawg", None, Some(song.clone()))
        );
        // The original is now just a source: no Replace, and export mixes.
        assert!(matches!(
            s.replace_original(&dir.join("backups")),
            Err(SessionSaveError::NoOriginal)
        ));

        let json = String::from_utf8(fs::read(&song).unwrap()).unwrap();
        assert!(json.contains("\"file\": \"Samples/a.wav\""), "{json}");
        assert!(json.contains("\"stretch\": 1.5"), "{json}");
        assert!(json.contains("\"pitch\": -3.5"), "{json}");
        assert!(json.contains("\"kind\": \"bell\""), "{json}");
        assert!(json.contains("\"reversed\": true"), "{json}");
        assert!(json.contains("\"masterGain\""), "{json}");
        assert!(json.contains("\"fadeOutCurve\": \"s\""), "{json}");

        let mut r = Session::open_project(&song).unwrap();
        assert_eq!(r.state().master_db, s.state().master_db);
        let tracks = |s: &Session| serde_json::to_value(s.state().tracks).unwrap();
        assert_eq!(tracks(&r), tracks(&s));
        assert!(!r.dirty());
        assert_eq!(r.render_file(Codec::Wav).unwrap(), mix);
        // New ids don't collide with saved ones.
        r.apply(&Command::AddTrack { name: "new".into() }, false)
            .unwrap();
        let ids: Vec<u64> = r.project().tracks.iter().map(|t| t.id).collect();
        assert!(ids[..ids.len() - 1]
            .iter()
            .all(|&id| id < ids[ids.len() - 1]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_moved_project_folder_still_finds_its_files() {
        let dir = temp_dir("project-move");
        let a = dir.join("Old").join("Samples").join("a.wav");
        fs::create_dir_all(a.parent().unwrap()).unwrap();
        write_wav(&a, 2, 44_100, 441, 0.5);
        let mut s = Session::new_project();
        s.import(&[a], Placement::default()).unwrap();
        // The first file sets a new project's rate.
        assert_eq!(s.state().rate, 44_100);
        s.save_project(&dir.join("Old").join("song.dawg")).unwrap();
        fs::rename(dir.join("Old"), dir.join("New")).unwrap();

        let r = Session::open_project(&dir.join("New").join("song.dawg")).unwrap();
        let src = &r.state().sources[0];
        assert!(!src.missing);
        assert_eq!(src.path, dir.join("New").join("Samples").join("a.wav"));
        assert_eq!(r.project().clips().next().unwrap().1.len, 441);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_files_open_silent_and_can_be_located() {
        let dir = temp_dir("project-missing");
        let a = dir.join("a.wav");
        let b = dir.join("b.wav");
        write_wav(&a, 1, 44_100, 500, 0.25);
        write_wav(&b, 1, 44_100, 300, 0.5);
        let mut s = Session::new_project();
        s.import(&[a.clone(), b.clone()], Placement::default())
            .unwrap();
        let song = dir.join("song.dawg");
        s.save_project(&song).unwrap();
        let moved = dir.join("Moved");
        fs::create_dir_all(&moved).unwrap();
        fs::rename(&a, moved.join("a.wav")).unwrap();
        fs::rename(&b, moved.join("b.wav")).unwrap();

        let mut r = Session::open_project(&song).unwrap();
        let st = r.state();
        assert!(st.sources.iter().all(|s| s.missing));
        // Clips keep their shape and play silence.
        assert_eq!(st.tracks[0].clips[0].len, 500);
        assert!(r.project().sources[0].samples().iter().all(|&x| x == 0.0));

        // Finding one finds its neighbour by name.
        let id = st.sources[0].id;
        assert_eq!(r.relink(id, &moved.join("a.wav")).unwrap(), 2);
        let st = r.state();
        assert!(st.sources.iter().all(|s| !s.missing));
        assert!(st.dirty, "the new paths need saving");
        assert!((r.project().sources[1].samples()[0] - 0.5).abs() < 1e-5);
        let _ = fs::remove_dir_all(&dir);
    }
}
