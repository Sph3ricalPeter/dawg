//! Edits as plain data. The UI, the CLI and the MCP server all describe a
//! change as a [`Command`]; [`Command::apply`] checks it and returns the new
//! project, leaving the old snapshot untouched for undo.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::model::{Clip, Project};

/// Clips are addressed by track and position for now; stable ids come with
/// multi-track editing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClipRef {
    pub track: usize,
    pub clip: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Set which source frames a clip plays and where it sits. Crop and
    /// edge-trims are both this.
    TrimClip {
        #[serde(flatten)]
        at: ClipRef,
        start: u64,
        offset: u64,
        len: u64,
    },
    /// Clip gain in dB, -96 (silence) to +24.
    SetClipGain {
        #[serde(flatten)]
        at: ClipRef,
        gain_db: f32,
    },
    /// Fade lengths in frames; clamped so they fit inside the clip.
    SetClipFades {
        #[serde(flatten)]
        at: ClipRef,
        fade_in: u64,
        fade_out: u64,
    },
}

/// A command that does not fit the project. The message is for people and
/// agents alike.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandError(pub String);

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CommandError {}

pub const MIN_GAIN_DB: f32 = -96.0;
pub const MAX_GAIN_DB: f32 = 24.0;

/// dB to linear; [`MIN_GAIN_DB`] and below is silence, 0 dB is exactly 1.
pub fn db_to_gain(db: f32) -> f32 {
    if db <= MIN_GAIN_DB {
        0.0
    } else if db == 0.0 {
        1.0
    } else {
        10f32.powf(db / 20.0)
    }
}

pub fn gain_to_db(gain: f32) -> f32 {
    if gain <= 0.0 {
        MIN_GAIN_DB
    } else if gain == 1.0 {
        0.0
    } else {
        (20.0 * gain.log10()).max(MIN_GAIN_DB)
    }
}

impl Command {
    pub fn apply(&self, project: &Project) -> Result<Project, CommandError> {
        let mut p = project.clone();
        match *self {
            Command::TrimClip {
                at,
                start,
                offset,
                len,
            } => {
                let clip = clip_mut(&mut p, at)?;
                let frames = clip.source.frames();
                if len == 0 {
                    return Err(CommandError("a clip can't be trimmed to nothing".into()));
                }
                if offset.checked_add(len).is_none_or(|end| end > frames) {
                    return Err(CommandError(format!(
                        "trim {offset}..{} runs past the source's {frames} frames",
                        offset.saturating_add(len)
                    )));
                }
                clip.start = start;
                clip.offset = offset;
                clip.len = len;
                fit_fades(clip);
            }
            Command::SetClipGain { at, gain_db } => {
                if !gain_db.is_finite() {
                    return Err(CommandError("gain must be a number".into()));
                }
                clip_mut(&mut p, at)?.gain = db_to_gain(gain_db.clamp(MIN_GAIN_DB, MAX_GAIN_DB));
            }
            Command::SetClipFades {
                at,
                fade_in,
                fade_out,
            } => {
                let clip = clip_mut(&mut p, at)?;
                clip.fade_in = fade_in;
                clip.fade_out = fade_out;
                fit_fades(clip);
            }
        }
        Ok(p)
    }
}

fn clip_mut(p: &mut Project, at: ClipRef) -> Result<&mut Clip, CommandError> {
    p.tracks
        .get_mut(at.track)
        .and_then(|t| t.clips.get_mut(at.clip))
        .ok_or_else(|| CommandError(format!("no clip {} on track {}", at.clip, at.track)))
}

/// Shortens fades that no longer fit, the fade-out first.
fn fit_fades(clip: &mut Clip) {
    clip.fade_in = clip.fade_in.min(clip.len);
    clip.fade_out = clip.fade_out.min(clip.len - clip.fade_in);
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::model::{Source, Track};

    const AT: ClipRef = ClipRef { track: 0, clip: 0 };

    fn project() -> Project {
        let src = Arc::new(Source::new(1, vec![0.0; 1000]));
        Project {
            sample_rate: 48_000,
            tracks: vec![Track {
                clips: vec![Clip::new(src, 0)],
                ..Track::default()
            }],
        }
    }

    #[test]
    fn trim_checks_bounds_and_keeps_fades_inside() {
        let p = Command::SetClipFades {
            at: AT,
            fade_in: 400,
            fade_out: 400,
        }
        .apply(&project())
        .unwrap();
        let trim = |offset, len| Command::TrimClip {
            at: AT,
            start: offset,
            offset,
            len,
        };
        let q = trim(100, 500).apply(&p).unwrap();
        let c = &q.tracks[0].clips[0];
        assert_eq!((c.start, c.offset, c.len), (100, 100, 500));
        assert_eq!((c.fade_in, c.fade_out), (400, 100));
        assert!(trim(900, 101).apply(&p).is_err());
        assert!(trim(0, 0).apply(&p).is_err());
        assert!(trim(u64::MAX, 2).apply(&p).is_err());
    }

    #[test]
    fn gain_is_exact_at_zero_db_and_clamped() {
        let p = project();
        let g = |db| {
            Command::SetClipGain {
                at: AT,
                gain_db: db,
            }
            .apply(&p)
            .unwrap()
            .tracks[0]
                .clips[0]
                .gain
        };
        assert_eq!(g(0.0), 1.0);
        assert_eq!(g(-200.0), 0.0);
        assert!((g(6.0) - 1.995).abs() < 1e-3);
        assert!((g(100.0) - db_to_gain(MAX_GAIN_DB)).abs() < 1e-6);
        assert!(Command::SetClipGain {
            at: AT,
            gain_db: f32::NAN
        }
        .apply(&p)
        .is_err());
    }

    #[test]
    fn serializes_for_agents() {
        let c = Command::SetClipGain {
            at: AT,
            gain_db: -3.0,
        };
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(
            json,
            r#"{"type":"set_clip_gain","track":0,"clip":0,"gain_db":-3.0}"#
        );
        assert_eq!(serde_json::from_str::<Command>(&json).unwrap(), c);
        assert!(Command::TrimClip {
            at: ClipRef { track: 3, clip: 0 },
            start: 0,
            offset: 0,
            len: 1
        }
        .apply(&project())
        .is_err());
    }
}
