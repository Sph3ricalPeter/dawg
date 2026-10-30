//! Test scenes shared by the golden-render and real-time tests.
//!
//! Signals are built from integer arithmetic only (no `sin`), so they are
//! bit-identical on every platform and libm.

use std::sync::Arc;

use dawg_core::{BandKind, Clip, EnvPoint, Eq, EqBand, Project, Source, Track};

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
            project: Arc::new(Project::with_tracks(
                RATE,
                vec![Track {
                    clips: vec![Clip::new(mono(triangle(2400, 109, 0.8)), 600)],
                    ..Track::default()
                }],
            )),
            frames: 4800,
        },
        Scene {
            name: "two_tracks_overlap",
            project: Arc::new(Project::with_tracks(
                RATE,
                vec![
                    Track {
                        clips: vec![Clip {
                            gain: 0.5,
                            ..Clip::new(
                                stereo(&triangle(3000, 218, 0.9), &triangle(3000, 145, 0.9)),
                                0,
                            )
                        }],
                        gain: 0.8,
                        ..Track::default()
                    },
                    Track {
                        clips: vec![
                            Clip::new(mono(noise(1500, 7, 0.3)), 1200),
                            Clip::new(mono(noise(1500, 11, 0.3)), 3300),
                        ],
                        ..Track::default()
                    },
                ],
            )),
            frames: 4800,
        },
        Scene {
            name: "trim_and_mute",
            project: Arc::new(Project::with_tracks(
                RATE,
                vec![
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
                        muted: true,
                        ..Track::default()
                    },
                ],
            )),
            frames: 4800,
        },
        Scene {
            name: "fades_and_gain",
            project: Arc::new(Project::with_tracks(
                RATE,
                vec![Track {
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
            )),
            frames: 4800,
        },
        Scene {
            name: "envelope_pan_solo",
            project: Arc::new(Project::with_tracks(
                RATE,
                vec![
                    Track {
                        clips: vec![Clip {
                            offset: 200,
                            len: 3600,
                            envelope: Arc::new([
                                EnvPoint { at: 400, gain: 0.0 },
                                EnvPoint {
                                    at: 1600,
                                    gain: 1.25,
                                },
                                EnvPoint {
                                    at: 3000,
                                    gain: 0.5,
                                },
                            ]),
                            ..Clip::new(mono(triangle(4000, 83, 0.7)), 600)
                        }],
                        pan: -0.5,
                        solo: true,
                        ..Track::default()
                    },
                    Track {
                        clips: vec![Clip::new(
                            stereo(&noise(4800, 13, 0.4), &noise(4800, 17, 0.4)),
                            0,
                        )],
                        gain: 0.7,
                        pan: 0.75,
                        solo: true,
                        ..Track::default()
                    },
                    Track {
                        // Silent: other tracks are soloed.
                        clips: vec![Clip::new(mono(noise(4800, 19, 1.0)), 0)],
                        ..Track::default()
                    },
                ],
            )),
            frames: 4800,
        },
        Scene {
            name: "eq_bell_and_cut",
            project: Arc::new(Project::with_tracks(
                RATE,
                vec![
                    Track {
                        clips: vec![Clip::new(
                            stereo(&noise(4800, 23, 0.5), &triangle(4800, 71, 0.6)),
                            0,
                        )],
                        eq: Eq::new(
                            &[
                                band(BandKind::LowCut, 300.0, 0.0, 24),
                                band(BandKind::Bell, 2500.0, 9.0, 12),
                                band(BandKind::HighShelf, 9000.0, -6.0, 12),
                            ],
                            false,
                            RATE,
                        ),
                        pan: 0.3,
                        ..Track::default()
                    },
                    Track {
                        clips: vec![Clip::new(mono(noise(3000, 29, 0.3)), 900)],
                        eq: Eq::new(&[band(BandKind::HighCut, 1200.0, 0.0, 18)], false, RATE),
                        ..Track::default()
                    },
                ],
            )),
            frames: 4800,
        },
        Scene {
            name: "stretch_and_pitch",
            project: Arc::new(Project::with_tracks(
                RATE,
                vec![Track {
                    clips: vec![
                        retimed(
                            Clip {
                                offset: 100,
                                len: 3000,
                                fade_out: 300,
                                ..Clip::new(mono(triangle(2400, 120, 0.7)), 0)
                            },
                            1.5,
                            0.0,
                        ),
                        retimed(
                            Clip::new(
                                stereo(&triangle(2000, 90, 0.5), &noise(2000, 31, 0.3)),
                                3000,
                            ),
                            0.8,
                            -5.0,
                        ),
                    ],
                    ..Track::default()
                }],
            )),
            frames: 4800,
        },
    ]
}

fn band(kind: BandKind, freq: f32, gain_db: f32, slope: u8) -> EqBand {
    EqBand {
        kind,
        freq,
        gain_db,
        q: 0.71,
        slope,
        on: true,
    }
}

/// `clip` stretched and pitched, its audio made.
fn retimed(mut clip: Clip, stretch: f64, pitch: f32) -> Clip {
    clip.stretch = stretch;
    clip.pitch = pitch;
    clip.len = clip.len.min(clip.max_len(clip.offset));
    clip.retime(RATE, None);
    clip
}
