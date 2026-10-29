//! Edits as plain data. The UI, the CLI and the MCP server all describe a
//! change as a [`Command`]; [`Command::apply`] checks it and returns the new
//! project, leaving the old snapshot untouched for undo.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::model::{Clip, EnvPoint, Project, Track, ENV_MAX};

/// Shortest clip a trim or split can leave, in frames.
pub const MIN_CLIP: u64 = 16;

/// Tracks and clips are addressed by their stable ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Set which source frames a clip plays and where it sits. Crop and
    /// edge-trims are both this.
    TrimClip {
        clip: u64,
        start: u64,
        offset: u64,
        len: u64,
    },
    /// Move a clip to `start` on `track` (its own or another).
    MoveClip {
        clip: u64,
        track: u64,
        start: u64,
    },
    /// Clip gain in dB, -96 (silence) to +24.
    SetClipGain {
        clip: u64,
        gain_db: f32,
    },
    /// Fade lengths in frames; clamped so they fit inside the clip.
    SetClipFades {
        clip: u64,
        fade_in: u64,
        fade_out: u64,
    },
    /// Replace a clip's volume envelope. Points are source frames and linear
    /// gains (0 to 1.25); they are sorted, and gains are clamped.
    SetEnvelope {
        clip: u64,
        points: Vec<EnvPoint>,
    },
    /// Place a source on a track; the whole source, at `start`.
    AddClip {
        source: u64,
        track: u64,
        start: u64,
    },
    DeleteClip {
        clip: u64,
    },
    /// Cut a clip in two at timeline frame `at`.
    SplitClip {
        clip: u64,
        at: u64,
    },
    /// Copy a clip to just after itself, on the same track.
    DuplicateClip {
        clip: u64,
    },
    /// A new empty track at the bottom.
    AddTrack {
        name: String,
    },
    /// A track and every clip on it.
    DeleteTrack {
        track: u64,
    },
    RenameTrack {
        track: u64,
        name: String,
    },
    /// Track volume (-96 to +12 dB), pan (-1 to 1), mute and solo. Fields
    /// left out stay as they are.
    SetTrackMix {
        track: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gain_db: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pan: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        muted: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        solo: Option<bool>,
    },
    /// Several edits as one: all apply or none do.
    Batch {
        commands: Vec<Command>,
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
/// Loudest a track fader goes.
pub const MAX_TRACK_DB: f32 = 12.0;

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

fn err<T>(msg: impl Into<String>) -> Result<T, CommandError> {
    Err(CommandError(msg.into()))
}

fn finite(v: f32, what: &str) -> Result<f32, CommandError> {
    if v.is_finite() {
        Ok(v)
    } else {
        err(format!("{what} must be a number"))
    }
}

impl Command {
    pub fn apply(&self, project: &Project) -> Result<Project, CommandError> {
        let mut p = project.clone();
        self.apply_in_place(&mut p)?;
        Ok(p)
    }

    pub(crate) fn apply_in_place(&self, p: &mut Project) -> Result<(), CommandError> {
        match self {
            Command::TrimClip {
                clip,
                start,
                offset,
                len,
            } => {
                let (start, offset, len) = (*start, *offset, *len);
                let clip = clip_mut(p, *clip)?;
                let frames = clip.source.frames();
                if len == 0 {
                    return err("a clip can't be trimmed to nothing");
                }
                if offset.checked_add(len).is_none_or(|end| end > frames) {
                    return err(format!(
                        "trim {offset}..{} runs past the source's {frames} frames",
                        offset.saturating_add(len)
                    ));
                }
                if start.checked_add(len).is_none() {
                    return err("the clip would end past the end of time");
                }
                clip.start = start;
                clip.offset = offset;
                clip.len = len;
                fit_fades(clip);
            }
            Command::MoveClip { clip, track, start } => {
                let to = track_index(p, *track)?;
                let (from, i) = clip_index(p, *clip)?;
                if start.checked_add(p.tracks[from].clips[i].len).is_none() {
                    return err("the clip would end past the end of time");
                }
                let mut c = p.tracks[from].clips.remove(i);
                c.start = *start;
                p.tracks[to].clips.push(c);
            }
            Command::SetClipGain { clip, gain_db } => {
                let db = finite(*gain_db, "gain")?;
                clip_mut(p, *clip)?.gain = db_to_gain(db.clamp(MIN_GAIN_DB, MAX_GAIN_DB));
            }
            Command::SetClipFades {
                clip,
                fade_in,
                fade_out,
            } => {
                let clip = clip_mut(p, *clip)?;
                clip.fade_in = *fade_in;
                clip.fade_out = *fade_out;
                fit_fades(clip);
            }
            Command::SetEnvelope { clip, points } => {
                let clip = clip_mut(p, *clip)?;
                let frames = clip.source.frames();
                let mut pts = Vec::with_capacity(points.len());
                for pt in points {
                    let gain = finite(pt.gain, "an envelope gain")?;
                    if pt.at >= frames {
                        return err(format!(
                            "envelope point at {} is past the source's {frames} frames",
                            pt.at
                        ));
                    }
                    pts.push(EnvPoint {
                        at: pt.at,
                        gain: gain.clamp(0.0, ENV_MAX),
                    });
                }
                pts.sort_by_key(|pt| pt.at);
                clip.envelope = pts.into();
            }
            Command::AddClip {
                source,
                track,
                start,
            } => {
                let t = track_index(p, *track)?;
                let src = p
                    .source(*source)
                    .cloned()
                    .ok_or_else(|| CommandError(format!("no source {source}")))?;
                if start.checked_add(src.frames()).is_none() {
                    return err("the clip would end past the end of time");
                }
                let id = p.new_id();
                p.tracks[t].clips.push(Clip {
                    id,
                    ..Clip::new(src, *start)
                });
            }
            Command::DeleteClip { clip } => {
                let (t, i) = clip_index(p, *clip)?;
                p.tracks[t].clips.remove(i);
            }
            Command::SplitClip { clip, at } => {
                let (t, i) = clip_index(p, *clip)?;
                let c = &p.tracks[t].clips[i];
                if *at < c.start + MIN_CLIP || *at + MIN_CLIP > c.end() {
                    return err("split inside the clip, away from its edges");
                }
                let head = at - c.start;
                let mut left = c.clone();
                let mut right = c.clone();
                left.len = head;
                left.fade_out = 0;
                right.start = *at;
                right.offset += head;
                right.len -= head;
                right.fade_in = 0;
                right.id = p.new_id();
                fit_fades(&mut left);
                fit_fades(&mut right);
                let clips = &mut p.tracks[t].clips;
                clips[i] = left;
                clips.insert(i + 1, right);
            }
            Command::DuplicateClip { clip } => {
                let (t, i) = clip_index(p, *clip)?;
                let mut c = p.tracks[t].clips[i].clone();
                if c.end().checked_add(c.len).is_none() {
                    return err("the copy would end past the end of time");
                }
                c.start = c.end();
                c.id = p.new_id();
                p.tracks[t].clips.insert(i + 1, c);
            }
            Command::AddTrack { name } => {
                let id = p.new_id();
                p.tracks.push(Track {
                    id,
                    name: name.clone(),
                    ..Track::default()
                });
            }
            Command::DeleteTrack { track } => {
                let t = track_index(p, *track)?;
                p.tracks.remove(t);
            }
            Command::RenameTrack { track, name } => {
                let t = track_index(p, *track)?;
                p.tracks[t].name = name.trim().to_string();
            }
            Command::SetTrackMix {
                track,
                gain_db,
                pan,
                muted,
                solo,
            } => {
                let t = track_index(p, *track)?;
                let tr = &mut p.tracks[t];
                if let Some(db) = gain_db {
                    let db = finite(*db, "volume")?;
                    tr.gain = db_to_gain(db.clamp(MIN_GAIN_DB, MAX_TRACK_DB));
                }
                if let Some(pan) = pan {
                    tr.pan = finite(*pan, "pan")?.clamp(-1.0, 1.0);
                }
                if let Some(m) = muted {
                    tr.muted = *m;
                }
                if let Some(s) = solo {
                    tr.solo = *s;
                }
            }
            Command::Batch { commands } => {
                for c in commands {
                    c.apply_in_place(p)?;
                }
            }
        }
        Ok(())
    }
}

fn track_index(p: &Project, id: u64) -> Result<usize, CommandError> {
    p.tracks
        .iter()
        .position(|t| t.id == id)
        .ok_or_else(|| CommandError(format!("no track {id}")))
}

/// Track index and position of clip `id`.
fn clip_index(p: &Project, id: u64) -> Result<(usize, usize), CommandError> {
    p.tracks
        .iter()
        .enumerate()
        .find_map(|(t, track)| track.clips.iter().position(|c| c.id == id).map(|i| (t, i)))
        .ok_or_else(|| CommandError(format!("no clip {id}")))
}

fn clip_mut(p: &mut Project, id: u64) -> Result<&mut Clip, CommandError> {
    let (t, i) = clip_index(p, id)?;
    Ok(&mut p.tracks[t].clips[i])
}

/// Shortens fades that no longer fit, the fade-out first.
pub(crate) fn fit_fades(clip: &mut Clip) {
    clip.fade_in = clip.fade_in.min(clip.len);
    clip.fade_out = clip.fade_out.min(clip.len - clip.fade_in);
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::model::Source;

    /// Track 1 holds clip 2 (source 3, 1000 frames); track 4 is empty.
    fn project() -> Project {
        let src = Arc::new(Source::new(1, vec![0.0; 1000]).with_id(3));
        let mut p = Project::new(48_000);
        p.tracks = vec![
            Track {
                id: 1,
                clips: vec![Clip {
                    id: 2,
                    ..Clip::new(src.clone(), 0)
                }],
                ..Track::default()
            },
            Track {
                id: 4,
                ..Track::default()
            },
        ];
        p.sources = vec![src];
        p.next_id = 5;
        p
    }

    fn clip(p: &Project, id: u64) -> &Clip {
        p.clip(id).unwrap().1
    }

    #[test]
    fn trim_checks_bounds_and_keeps_fades_inside() {
        let p = Command::SetClipFades {
            clip: 2,
            fade_in: 400,
            fade_out: 400,
        }
        .apply(&project())
        .unwrap();
        let trim = |offset, len| Command::TrimClip {
            clip: 2,
            start: offset,
            offset,
            len,
        };
        let q = trim(100, 500).apply(&p).unwrap();
        let c = clip(&q, 2);
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
            clip(
                &Command::SetClipGain {
                    clip: 2,
                    gain_db: db,
                }
                .apply(&p)
                .unwrap(),
                2,
            )
            .gain
        };
        assert_eq!(g(0.0), 1.0);
        assert_eq!(g(-200.0), 0.0);
        assert!((g(6.0) - 1.995).abs() < 1e-3);
        assert!((g(100.0) - db_to_gain(MAX_GAIN_DB)).abs() < 1e-6);
        assert!(Command::SetClipGain {
            clip: 2,
            gain_db: f32::NAN
        }
        .apply(&p)
        .is_err());
    }

    #[test]
    fn moves_clips_between_tracks() {
        let p = Command::MoveClip {
            clip: 2,
            track: 4,
            start: 300,
        }
        .apply(&project())
        .unwrap();
        assert!(p.tracks[0].clips.is_empty());
        assert_eq!(p.tracks[1].clips[0].start, 300);
        assert!(Command::MoveClip {
            clip: 2,
            track: 9,
            start: 0
        }
        .apply(&p)
        .is_err());
    }

    #[test]
    fn split_and_duplicate_make_new_clips() {
        let p = Command::Batch {
            commands: vec![
                Command::SetClipFades {
                    clip: 2,
                    fade_in: 100,
                    fade_out: 100,
                },
                Command::SplitClip { clip: 2, at: 400 },
            ],
        }
        .apply(&project())
        .unwrap();
        let clips = &p.tracks[0].clips;
        assert_eq!(clips.len(), 2);
        assert_eq!(
            (
                clips[0].id,
                clips[0].len,
                clips[0].fade_in,
                clips[0].fade_out
            ),
            (2, 400, 100, 0)
        );
        assert_eq!(
            (clips[1].id, clips[1].start, clips[1].offset, clips[1].len),
            (5, 400, 400, 600)
        );
        assert_eq!((clips[1].fade_in, clips[1].fade_out), (0, 100));
        assert!(Command::SplitClip { clip: 2, at: 2 }.apply(&p).is_err());

        let q = Command::DuplicateClip { clip: 5 }.apply(&p).unwrap();
        let copy = &q.tracks[0].clips[2];
        assert_eq!((copy.id, copy.start, copy.offset), (6, 1000, 400));
        assert_eq!(q.next_id, 7);
    }

    #[test]
    fn a_failed_batch_changes_nothing() {
        let p = project();
        let bad = Command::Batch {
            commands: vec![
                Command::DeleteClip { clip: 2 },
                Command::DeleteClip { clip: 2 },
            ],
        };
        assert!(bad.apply(&p).is_err());
        assert!(Command::AddClip {
            source: 3,
            track: 4,
            start: 10
        }
        .apply(&p)
        .is_ok_and(|q| q.tracks[1].clips[0].id == 5));
        assert!(Command::AddClip {
            source: 8,
            track: 4,
            start: 10
        }
        .apply(&p)
        .is_err());
    }

    #[test]
    fn envelopes_are_sorted_and_clamped() {
        let p = Command::SetEnvelope {
            clip: 2,
            points: vec![
                EnvPoint { at: 500, gain: 0.0 },
                EnvPoint { at: 100, gain: 9.0 },
            ],
        }
        .apply(&project())
        .unwrap();
        let c = clip(&p, 2);
        assert_eq!(
            &c.envelope[..],
            &[
                EnvPoint {
                    at: 100,
                    gain: ENV_MAX
                },
                EnvPoint { at: 500, gain: 0.0 }
            ]
        );
        assert_eq!(c.envelope_at(0), ENV_MAX as f64);
        assert_eq!(c.envelope_at(300), ENV_MAX as f64 / 2.0);
        assert_eq!(c.envelope_at(900), 0.0);
        assert!(Command::SetEnvelope {
            clip: 2,
            points: vec![EnvPoint {
                at: 1000,
                gain: 1.0
            }]
        }
        .apply(&p)
        .is_err());
    }

    #[test]
    fn track_mix_changes_only_what_it_names() {
        let p = Command::SetTrackMix {
            track: 1,
            gain_db: Some(-6.0),
            pan: Some(-3.0),
            muted: None,
            solo: Some(true),
        }
        .apply(&project())
        .unwrap();
        let t = &p.tracks[0];
        assert!((t.gain - 0.501).abs() < 1e-3);
        assert_eq!((t.pan, t.muted, t.solo), (-1.0, false, true));
        assert!(!p.audible(&p.tracks[1]));
        let (l, r) = t.side_gains();
        assert_eq!((l, r), (t.gain, 0.0));
    }

    #[test]
    fn serializes_for_agents() {
        let c = Command::SetClipGain {
            clip: 2,
            gain_db: -3.0,
        };
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(json, r#"{"type":"set_clip_gain","clip":2,"gain_db":-3.0}"#);
        assert_eq!(serde_json::from_str::<Command>(&json).unwrap(), c);
        let mix: Command =
            serde_json::from_str(r#"{"type":"set_track_mix","track":1,"muted":true}"#).unwrap();
        assert!(mix.apply(&project()).unwrap().tracks[0].muted);
    }
}
