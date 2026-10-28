//! An editing session on one WAV file: the "Edit in dawg" scratch session.
//!
//! The file becomes one clip on one track at its own sample rate. Edits are
//! [`Command`]s; every committed edit is one undo step, and a drag sends
//! transient commands that collapse into one step when it ends.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::command::{gain_to_db, ClipRef, Command, CommandError};
use crate::model::{Clip, Project, Source, Track};
use crate::peaks::Peaks;
use crate::save::{self, FileStamp, Replaced, SaveError};
use crate::wav::{WavError, WavFile, WavFormat};

/// The clip being edited.
pub const CLIP: ClipRef = ClipRef { track: 0, clip: 0 };

/// Undo steps kept.
const HISTORY: usize = 200;

#[derive(Debug)]
pub enum OpenError {
    Io(io::Error),
    Wav(WavError),
    Empty,
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpenError::Io(e) => write!(f, "{e}"),
            OpenError::Wav(e) => write!(f, "{e}"),
            OpenError::Empty => write!(f, "the file has no audio in it"),
        }
    }
}

impl std::error::Error for OpenError {}

pub struct Session {
    path: PathBuf,
    file: Arc<WavFile>,
    source: Arc<Source>,
    peaks: Peaks,
    stamp: FileStamp,
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
    pub path: PathBuf,
    pub name: String,
    pub format: WavFormat,
    /// Frames in the file.
    pub frames: u64,
    pub clip: ClipState,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    /// Chunk ids carried over on save, besides `fmt ` and `data`.
    pub extra_chunks: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipState {
    pub start: u64,
    pub offset: u64,
    pub len: u64,
    pub gain_db: f32,
    pub fade_in: u64,
    pub fade_out: u64,
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

impl Session {
    pub fn open(path: &Path) -> Result<Session, OpenError> {
        let stamp = FileStamp::of(path).map_err(OpenError::Io)?;
        // Read once and keep no handle open, so other programs (and our own
        // replace) can write the file.
        let bytes = fs::read(path).map_err(OpenError::Io)?;
        let file = WavFile::parse(bytes).map_err(OpenError::Wav)?;
        if file.frames() == 0 {
            return Err(OpenError::Empty);
        }
        Ok(Self::from_file(path.to_path_buf(), file, stamp))
    }

    fn from_file(path: PathBuf, file: WavFile, stamp: FileStamp) -> Session {
        let source = Arc::new(file.decode());
        let peaks = Peaks::new(&source);
        let project = Arc::new(Project {
            sample_rate: file.format().sample_rate,
            tracks: vec![Track {
                clips: vec![Clip::new(source.clone(), 0)],
                ..Track::default()
            }],
        });
        Session {
            path,
            file: Arc::new(file),
            source,
            peaks,
            stamp,
            saved: project.clone(),
            project,
            undo: Vec::new(),
            redo: Vec::new(),
            in_gesture: false,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn project(&self) -> &Arc<Project> {
        &self.project
    }

    pub fn source(&self) -> &Arc<Source> {
        &self.source
    }

    pub fn peaks(&self) -> &Peaks {
        &self.peaks
    }

    pub fn clip(&self) -> &Clip {
        &self.project.tracks[CLIP.track].clips[CLIP.clip]
    }

    pub fn dirty(&self) -> bool {
        !self.project.same_edit(&self.saved)
    }

    pub fn state(&self) -> SessionState {
        let c = self.clip();
        SessionState {
            path: self.path.clone(),
            name: self
                .path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            format: self.file.format(),
            frames: self.file.frames(),
            clip: ClipState {
                start: c.start,
                offset: c.offset,
                len: c.len,
                gain_db: gain_to_db(c.gain),
                fade_in: c.fade_in,
                fade_out: c.fade_out,
            },
            dirty: self.dirty(),
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            extra_chunks: self.file.extra_chunks(),
            truncated: self.file.truncated(),
        }
    }

    /// Applies `cmd`. A `transient` command is part of a drag: the first one
    /// records the undo step and the rest replace the live state until
    /// [`Session::end_gesture`].
    pub fn apply(&mut self, cmd: &Command, transient: bool) -> Result<(), CommandError> {
        let next = cmd.apply(&self.project)?;
        if !self.in_gesture {
            if next.same_edit(&self.project) {
                return Ok(());
            }
            self.push_undo();
        }
        self.project = Arc::new(next);
        self.in_gesture = true;
        if !transient {
            self.end_gesture();
        }
        Ok(())
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

    /// The file as the current edit would save it.
    pub fn render_file(&self) -> Result<Vec<u8>, WavError> {
        self.file.render_clip(self.clip())
    }

    pub fn preview(&self) -> SavePreview {
        let c = self.clip();
        let fmt = self.file.format();
        let ch = fmt.channels as usize;
        let s = self.source.samples();
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
            frames_before: self.file.frames(),
            frames_after: c.len,
            cut_start: c.offset,
            cut_end: self.file.frames() - c.offset - c.len,
            peak_db: if peak > 0.0 {
                (20.0 * peak.log10()) as f32
            } else {
                f32::NEG_INFINITY
            },
            clipped: !fmt.float && peak > 1.0,
            untouched: c.offset == 0 && c.len == self.file.frames() && c.is_unity(),
        }
    }

    /// Writes the edit over the original, keeping a backup in `backup_dir`.
    /// The session then reopens the new file, so further edits start from
    /// what is on disk.
    pub fn replace_original(&mut self, backup_dir: &Path) -> Result<Replaced, SessionSaveError> {
        let bytes = self.render_file()?;
        let r = save::replace(&self.path, &bytes, backup_dir, Some(self.stamp))?;
        self.reload_saved(bytes)?;
        Ok(r)
    }

    /// Writes the edit to a new file. The session stays on the original.
    pub fn save_as_new(&self, path: &Path) -> Result<(), SessionSaveError> {
        let bytes = self.render_file()?;
        save::write_new(path, &bytes)?;
        Ok(())
    }

    fn reload_saved(&mut self, bytes: Vec<u8>) -> Result<(), SessionSaveError> {
        let stamp = FileStamp::of(&self.path).map_err(SaveError::from)?;
        let file = WavFile::parse(bytes)?;
        *self = Self::from_file(self.path.clone(), file, stamp);
        Ok(())
    }
}

#[derive(Debug)]
pub enum SessionSaveError {
    Wav(WavError),
    Save(SaveError),
}

impl SessionSaveError {
    pub fn kind(&self) -> &'static str {
        match self {
            SessionSaveError::Wav(_) => "format",
            SessionSaveError::Save(e) => e.kind(),
        }
    }
}

impl fmt::Display for SessionSaveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SessionSaveError::Wav(e) => write!(f, "{e}"),
            SessionSaveError::Save(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for SessionSaveError {}

impl From<WavError> for SessionSaveError {
    fn from(e: WavError) -> Self {
        SessionSaveError::Wav(e)
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
        let file = WavFile::parse(encode_simple(fmt, &samples)).unwrap();
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
            at: CLIP,
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
        assert_eq!(s.clip().len, 700);
        assert!(s.dirty());
        assert!(s.undo());
        assert_eq!(s.clip().len, 1000);
        assert!(!s.dirty());
        assert!(!s.undo());
        assert!(s.redo());
        assert_eq!(s.clip().len, 700);
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
                at: CLIP,
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
                at: CLIP,
                gain_db: 12.0,
            },
            false,
        )
        .unwrap();
        assert!(s.preview().clipped);
    }

    #[test]
    fn replace_writes_reopens_and_backs_up() {
        let dir = std::env::temp_dir().join(format!("dawg-session-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("kick.wav");
        let original = session(1000).file.bytes().to_vec();
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
        s.save_as_new(&copy).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), fs::read(&path).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }
}
