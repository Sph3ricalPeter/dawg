//! The `.dawg` project file: JSON, versioned, pointing at the audio it uses.
//!
//! A project stores the arrangement, not audio. Each source keeps the path of
//! its file relative to the project's folder (so a folder of project and
//! samples can move or sync to another machine) and the absolute path it had
//! (so a project saved away from its samples still finds them). Opening tries
//! the relative path first.
//!
//! Every update reaches every install, so the format only grows:
//!
//! - New data is a new field with `#[serde(default)]`, left out when it is at
//!   its default, so older projects keep opening and a project that doesn't
//!   use a feature saves as before.
//! - Each such addition bumps [`FORMAT_VERSION`]. A build refuses a newer
//!   version ([`ProjectError::Newer`]) rather than open it and then save it
//!   without what it doesn't understand.
//!
//! Versions: 1 the first; 2 adds clip `stretch` and `pitch` and track `eq`
//! and `eqBypass`; 3 adds clip `fadeInCurve`, `fadeOutCurve` and `reversed`;
//! 4 adds `masterGain`.

use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::eq::EqBand;
use crate::model::{EnvPoint, FadeCurve, Project};

/// The format this build writes, and the newest it reads.
pub const FORMAT_VERSION: u32 = 4;
/// File extension, without the dot.
pub const EXTENSION: &str = "dawg";
/// The `format` tag, so a stray JSON file isn't taken for a project.
const FORMAT_TAG: &str = "dawg project";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub format: String,
    pub version: u32,
    /// The dawg version that wrote it, for support. Not read back.
    #[serde(default)]
    pub saved_by: String,
    pub sample_rate: u32,
    /// The next id to hand out, so ids stay unique after reopening.
    pub next_id: u64,
    /// Master volume, linear.
    #[serde(default = "one_f32", skip_serializing_if = "is_one_f32")]
    pub master_gain: f32,
    pub sources: Vec<SourceEntry>,
    pub tracks: Vec<TrackEntry>,
}

/// An audio file the clips play.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEntry {
    pub id: u64,
    /// Relative to the project's folder with `/` between parts, or absolute
    /// when the file is on another drive.
    pub file: String,
    /// Where the file was when the project was saved.
    #[serde(default)]
    pub absolute: Option<PathBuf>,
    /// Frames at the project's rate and channels, so the clips keep their
    /// shape when the file is missing.
    pub frames: u64,
    pub channels: u16,
    /// The file's own sample rate.
    pub rate: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackEntry {
    pub id: u64,
    pub name: String,
    /// Linear gain.
    pub gain: f32,
    pub pan: f32,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub solo: bool,
    pub clips: Vec<ClipEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub eq: Vec<EqBand>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub eq_bypass: bool,
}

/// A clip, in frames at the project's rate. See [`crate::Clip`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipEntry {
    pub id: u64,
    pub source: u64,
    pub start: u64,
    pub offset: u64,
    pub len: u64,
    /// Linear gain.
    pub gain: f32,
    #[serde(default)]
    pub fade_in: u64,
    #[serde(default)]
    pub fade_out: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub envelope: Vec<EnvPoint>,
    /// Timeline frames per source frame.
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub stretch: f64,
    /// Semitones.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub pitch: f32,
    #[serde(default, skip_serializing_if = "is_linear")]
    pub fade_in_curve: FadeCurve,
    #[serde(default, skip_serializing_if = "is_linear")]
    pub fade_out_curve: FadeCurve,
    /// Plays backwards; `offset` and the envelope count from the source's end.
    #[serde(default, skip_serializing_if = "is_false")]
    pub reversed: bool,
}

fn is_linear(v: &FadeCurve) -> bool {
    *v == FadeCurve::Linear
}
fn is_false(v: &bool) -> bool {
    !*v
}
fn one_f32() -> f32 {
    1.0
}
fn is_one_f32(v: &f32) -> bool {
    *v == 1.0
}
fn one() -> f64 {
    1.0
}
fn is_one(v: &f64) -> bool {
    *v == 1.0
}
fn is_zero(v: &f32) -> bool {
    *v == 0.0
}

#[derive(Debug)]
pub enum ProjectError {
    Io(io::Error),
    /// Not a dawg project, or a damaged one.
    Invalid(String),
    /// Saved by a newer dawg, in this format version.
    Newer(u32),
}

impl ProjectError {
    pub fn kind(&self) -> &'static str {
        match self {
            ProjectError::Io(_) => "io",
            ProjectError::Invalid(_) => "invalid_project",
            ProjectError::Newer(_) => "newer_project",
        }
    }
}

impl fmt::Display for ProjectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProjectError::Io(e) => write!(f, "{e}"),
            ProjectError::Invalid(why) => write!(f, "this isn't a dawg project it can read: {why}"),
            ProjectError::Newer(v) => write!(
                f,
                "it was saved by a newer dawg (project format {v}); update dawg to open it"
            ),
        }
    }
}

impl std::error::Error for ProjectError {}

impl From<io::Error> for ProjectError {
    fn from(e: io::Error) -> Self {
        ProjectError::Io(e)
    }
}

impl ProjectFile {
    /// The arrangement of `project` for a project saved at `project_path`.
    /// `file_of` gives each source's file and that file's own rate. Sources
    /// no clip uses are left out.
    pub fn from_project(
        project: &Project,
        project_path: &Path,
        file_of: impl Fn(u64) -> Option<(PathBuf, u32)>,
    ) -> ProjectFile {
        let dir = project_path.parent().unwrap_or(Path::new(""));
        let mut sources: Vec<SourceEntry> = project
            .sources
            .iter()
            .filter(|s| project.clips().any(|(_, c)| c.source.id() == s.id()))
            .filter_map(|s| {
                let (abs, rate) = file_of(s.id())?;
                Some(SourceEntry {
                    id: s.id(),
                    file: relative(dir, &abs).unwrap_or_else(|| abs.to_string_lossy().into_owned()),
                    absolute: Some(abs),
                    frames: s.frames(),
                    channels: s.channels(),
                    rate,
                })
            })
            .collect();
        sources.sort_by_key(|s| s.id);
        ProjectFile {
            format: FORMAT_TAG.into(),
            version: FORMAT_VERSION,
            saved_by: crate::VERSION.into(),
            sample_rate: project.sample_rate,
            next_id: project.next_id,
            master_gain: project.master_gain,
            sources,
            tracks: project
                .tracks
                .iter()
                .map(|t| TrackEntry {
                    id: t.id,
                    name: t.name.clone(),
                    gain: t.gain,
                    pan: t.pan,
                    muted: t.muted,
                    solo: t.solo,
                    eq: t.eq.bands().to_vec(),
                    eq_bypass: t.eq.bypass(),
                    clips: t
                        .clips
                        .iter()
                        .map(|c| ClipEntry {
                            id: c.id,
                            source: c.source.id(),
                            start: c.start,
                            offset: c.offset,
                            len: c.len,
                            gain: c.gain,
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
        }
    }

    pub fn to_json(&self) -> Vec<u8> {
        let mut out = serde_json::to_vec_pretty(self).expect("a project always serializes");
        out.push(b'\n');
        out
    }

    /// Reads a project, refusing other JSON, damaged files and newer
    /// formats.
    pub fn parse(bytes: &[u8]) -> Result<ProjectFile, ProjectError> {
        #[derive(Deserialize)]
        struct Head {
            format: Option<String>,
            version: Option<u32>,
        }
        let head: Head =
            serde_json::from_slice(bytes).map_err(|e| ProjectError::Invalid(e.to_string()))?;
        if head.format.as_deref() != Some(FORMAT_TAG) {
            return Err(ProjectError::Invalid(
                "it has no dawg project header".into(),
            ));
        }
        let version = head.version.unwrap_or(0);
        if version > FORMAT_VERSION {
            return Err(ProjectError::Newer(version));
        }
        let file: ProjectFile =
            serde_json::from_slice(bytes).map_err(|e| ProjectError::Invalid(e.to_string()))?;
        if file.sample_rate == 0 {
            return Err(ProjectError::Invalid("its sample rate is 0".into()));
        }
        Ok(file)
    }

    /// Where a source's file should be, best guess first: next to the
    /// project as it was saved, then where it was.
    pub fn candidates(&self, source: &SourceEntry, project_path: &Path) -> Vec<PathBuf> {
        let dir = project_path.parent().unwrap_or(Path::new(""));
        let mut out = Vec::new();
        let file = Path::new(&source.file);
        if file.is_absolute() {
            out.push(file.to_path_buf());
        } else {
            let mut p = dir.to_path_buf();
            for part in source.file.split('/') {
                p.push(part);
            }
            out.push(p);
        }
        if let Some(abs) = &source.absolute {
            if !out.contains(abs) {
                out.push(abs.clone());
            }
        }
        out
    }
}

/// `to` relative to the folder `from`, with `/` between parts. `None` when
/// they share no root (another drive).
pub fn relative(from: &Path, to: &Path) -> Option<String> {
    let a: Vec<Component> = from.components().collect();
    let b: Vec<Component> = to.components().collect();
    if a.is_empty() || b.is_empty() || a[0] != b[0] {
        return None;
    }
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    if a[common..]
        .iter()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let mut parts: Vec<String> = vec!["..".into(); a.len() - common];
    for c in &b[common..] {
        match c {
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs(p: &str) -> PathBuf {
        // An absolute path on any platform.
        let root = if cfg!(windows) { "D:\\" } else { "/" };
        Path::new(root).join(p)
    }

    #[test]
    fn paths_are_relative_to_the_project_folder() {
        let proj = abs("Projects/Doors");
        assert_eq!(
            relative(&proj, &abs("Projects/Doors/Samples/kick.wav")).as_deref(),
            Some("Samples/kick.wav")
        );
        assert_eq!(
            relative(&proj, &abs("Samples/Foley/creak.wav")).as_deref(),
            Some("../../Samples/Foley/creak.wav")
        );
    }

    #[test]
    fn looks_next_to_the_project_first() {
        let f = ProjectFile {
            format: FORMAT_TAG.into(),
            version: 1,
            saved_by: String::new(),
            sample_rate: 48_000,
            next_id: 2,
            master_gain: 1.0,
            sources: vec![SourceEntry {
                id: 1,
                file: "Samples/kick.wav".into(),
                absolute: Some(abs("Old/Samples/kick.wav")),
                frames: 10,
                channels: 1,
                rate: 48_000,
            }],
            tracks: Vec::new(),
        };
        let moved = abs("New/song.dawg");
        let mut want = abs("New");
        want.push("Samples");
        want.push("kick.wav");
        assert_eq!(
            f.candidates(&f.sources[0], &moved),
            vec![want, abs("Old/Samples/kick.wav")]
        );
        assert_eq!(ProjectFile::parse(&f.to_json()).unwrap(), f);
    }

    #[test]
    fn refuses_newer_formats_and_other_json() {
        let newer = br#"{"format":"dawg project","version":99,"sampleRate":48000}"#;
        assert!(matches!(
            ProjectFile::parse(newer),
            Err(ProjectError::Newer(99))
        ));
        assert!(matches!(
            ProjectFile::parse(br#"{"tracks":[]}"#),
            Err(ProjectError::Invalid(_))
        ));
        assert!(matches!(
            ProjectFile::parse(b"RIFF"),
            Err(ProjectError::Invalid(_))
        ));
    }

    #[test]
    fn version_1_projects_open_with_no_stretch_pitch_or_eq() {
        let v1 = br#"{"format":"dawg project","version":1,"sampleRate":48000,"nextId":4,
            "sources":[{"id":1,"file":"a.wav","frames":10,"channels":1,"rate":48000}],
            "tracks":[{"id":2,"name":"a","gain":1.0,"pan":0.0,
              "clips":[{"id":3,"source":1,"start":0,"offset":0,"len":10,"gain":1.0}]}]}"#;
        let f = ProjectFile::parse(v1).unwrap();
        let (t, c) = (&f.tracks[0], &f.tracks[0].clips[0]);
        assert!(t.eq.is_empty() && !t.eq_bypass);
        assert_eq!((c.stretch, c.pitch), (1.0, 0.0));
        // And they save without the new fields.
        let json = String::from_utf8(f.to_json()).unwrap();
        assert!(
            !json.contains("stretch") && !json.contains("\"eq\""),
            "{json}"
        );
    }
}
