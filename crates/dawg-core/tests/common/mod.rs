//! Test scenes shared by the golden-render and real-time tests.
//!
//! Signals are built from integer arithmetic only (no `sin`), so they are
//! bit-identical on every platform and libm.

use std::sync::Arc;

use dawg_core::{Clip, Project, Source, Track};

pub const RATE: u32 = 48_000;

/// Triangle wave with a period of `period` frames, peak `amp`.
pub fn triangle(frames: usize, period: usize, amp: f32) -> Vec<f32> {
    (0..frames)
        .map(|i| {
            let p = (i % period) as f32 / period as f32;
            let tri = if p < 0.5 {
                4.0 * p - 1.0
            } else {
                3.0 - 4.0 * p
            };
            tri * amp
        })
        .collect()
}

/// Deterministic white noise from a 32-bit LCG, peak `amp`.
pub fn noise(frames: usize, seed: u32, amp: f32) -> Vec<f32> {
    let mut x = seed;
    (0..frames)
        .map(|_| {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((x >> 8) as f32 / (1u32 << 23) as f32 - 1.0) * amp
        })
        .collect()
}

fn interleave(l: &[f32], r: &[f32]) -> Vec<f32> {
    l.iter().zip(r).flat_map(|(&l, &r)| [l, r]).collect()
}

fn mono(samples: Vec<f32>) -> Arc<Source> {
    Arc::new(Source::new(1, samples))
}

fn stereo(l: &[f32], r: &[f32]) -> Arc<Source> {
    Arc::new(Source::new(2, interleave(l, r)))
}

pub struct Scene {
    pub name: &'static str,
    pub project: Arc<Project>,
    pub frames: usize,
}

/// Every scene the golden tests render. Add new ones at the end and bless.
pub fn scenes() -> Vec<Scene> {
    vec![
        Scene {
            name: "mono_clip_offset",
            project: Arc::new(Project {
                sample_rate: RATE,
                tracks: vec![Track {
                    clips: vec![Clip::new(mono(triangle(2400, 109, 0.8)), 600)],
                    ..Track::default()
                }],
            }),
            frames: 4800,
        },
        Scene {
            name: "two_tracks_overlap",
            project: Arc::new(Project {
                sample_rate: RATE,
                tracks: vec![
                    Track {
                        clips: vec![Clip {
                            gain: 0.5,
                            ..Clip::new(
                                stereo(&triangle(3000, 218, 0.9), &triangle(3000, 145, 0.9)),
                                0,
                            )
                        }],
                        gain: 0.8,
                        muted: false,
                    },
                    Track {
                        clips: vec![
                            Clip::new(mono(noise(1500, 7, 0.3)), 1200),
                            Clip::new(mono(noise(1500, 11, 0.3)), 3300),
                        ],
                        ..Track::default()
                    },
                ],
            }),
            frames: 4800,
        },
        Scene {
            name: "trim_and_mute",
            project: Arc::new(Project {
                sample_rate: RATE,
                tracks: vec![
                    Track {
                        clips: vec![Clip {
                            offset: 700,
                            len: 1900,
                            gain: 1.25,
                            ..Clip::new(mono(triangle(4000, 61, 0.6)), 400)
                        }],
                        ..Track::default()
                    },
                    Track {
                        clips: vec![Clip::new(mono(noise(4800, 3, 1.0)), 0)],
                        gain: 1.0,
                        muted: true,
                    },
                ],
            }),
            frames: 4800,
        },
        Scene {
            name: "fades_and_gain",
            project: Arc::new(Project {
                sample_rate: RATE,
                tracks: vec![Track {
                    clips: vec![Clip {
                        offset: 300,
                        len: 3000,
                        gain: 0.7,
                        fade_in: 480,
                        fade_out: 1200,
                        ..Clip::new(stereo(&triangle(4000, 97, 0.9), &noise(4000, 5, 0.5)), 1000)
                    }],
                    ..Track::default()
                }],
            }),
            frames: 4800,
        },
    ]
}
