use std::sync::Arc;

use crate::eq::MAX_SECTIONS;
use crate::model::{Clip, Project};

/// The mixer always renders interleaved stereo.
pub const OUT_CHANNELS: usize = 2;

/// Tracks with a level meter and an EQ; later ones play, but unmetered and
/// without their EQ.
pub const METER_TRACKS: usize = 64;

/// The tap's track id when it listens to none.
pub const NO_TAP: u64 = u64::MAX;

/// Frames an EQ'd track is mixed in at a time.
const CHUNK: usize = 256;

/// Filter state of one track's EQ: per section slot and side.
struct EqState {
    /// The track the state belongs to; another track in this slot starts
    /// from silence.
    track: u64,
    z: [[[f64; 2]; 2]; MAX_SECTIONS],
}

impl EqState {
    fn reset(&mut self, track: u64) {
        self.track = track;
        self.z = [[[0.0; 2]; 2]; MAX_SECTIONS];
    }
}

/// Plays a project from a position, one buffer at a time.
///
/// [`Renderer::process`] runs on the audio thread: it must never allocate,
/// lock or block. `tests/realtime.rs` enforces the allocation rule.
pub struct Renderer {
    project: Arc<Project>,
    pos: u64,
    /// Peak level per track (by index) and side since the last
    /// [`Renderer::take_peaks`], after the track's volume and pan.
    peaks: [[f32; 2]; METER_TRACKS],
    /// EQ state per track (by index), allocated up front.
    eq: Box<[EqState]>,
    /// A track's clips summed, before its EQ.
    scratch: Box<[f32; CHUNK * OUT_CHANNELS]>,
    /// Where one track's sound after its EQ goes, mono, for the analyser.
    tap: Option<rtrb::Producer<f32>>,
    /// The track tapped; [`NO_TAP`] for none.
    tap_track: u64,
}

impl Renderer {
    pub fn new(project: Arc<Project>, pos: u64) -> Self {
        Self {
            project,
            pos,
            peaks: [[0.0; 2]; METER_TRACKS],
            eq: (0..METER_TRACKS)
                .map(|_| EqState {
                    track: 0,
                    z: [[[0.0; 2]; 2]; MAX_SECTIONS],
                })
                .collect(),
            scratch: Box::new([0.0; CHUNK * OUT_CHANNELS]),
            tap: None,
            tap_track: NO_TAP,
        }
    }

    /// Sends the tapped track's sound to `sink` from now on.
    pub fn set_tap(&mut self, sink: rtrb::Producer<f32>) {
        self.tap = Some(sink);
    }

    /// Which track the tap listens to; [`NO_TAP`] for none. Real-time safe.
    pub fn tap_track(&mut self, track: u64) {
        self.tap_track = track;
    }

    /// Peak levels per track since the last call, which resets them. A
    /// track's clips are metered one at a time, so where they overlap the
    /// meter shows the louder one, not the sum.
    pub fn take_peaks(&mut self) -> [[f32; 2]; METER_TRACKS] {
        std::mem::replace(&mut self.peaks, [[0.0; 2]; METER_TRACKS])
    }

    /// Current timeline frame.
    pub fn position(&self) -> u64 {
        self.pos
    }

    /// Jumps to `pos`. EQ tails from before the jump are dropped.
    pub fn seek(&mut self, pos: u64) {
        self.pos = pos;
        for st in self.eq.iter_mut() {
            let t = st.track;
            st.reset(t);
        }
    }

    pub fn project(&self) -> &Arc<Project> {
        &self.project
    }

    /// Plays `project` from now on and hands back the previous snapshot, so
    /// the caller decides which thread frees it.
    pub fn swap_project(&mut self, project: Arc<Project>) -> Arc<Project> {
        std::mem::replace(&mut self.project, project)
    }

    /// Fills `out` (interleaved stereo) with the next frames and advances.
    pub fn process(&mut self, out: &mut [f32]) {
        debug_assert_eq!(out.len() % OUT_CHANNELS, 0);
        out.fill(0.0);
        let frames = (out.len() / OUT_CHANNELS) as u64;
        let (from, to) = (self.pos, self.pos + frames);

        let any_solo = self.project.tracks.iter().any(|t| t.solo);
        for (n, track) in self.project.tracks.iter().enumerate() {
            if track.muted || (any_solo && !track.solo) {
                continue;
            }
            let (gl, gr) = track.side_gains();
            let (mut pl, mut pr) = (0.0f32, 0.0f32);
            let tap = self.tap.as_mut().filter(|_| self.tap_track == track.id);
            let scratch = track.eq.active() || tap.is_some();
            let mut tap = tap;
            match self.eq.get_mut(n).filter(|_| scratch) {
                Some(st) => {
                    if st.track != track.id {
                        st.reset(track.id);
                    }
                    let sections = track.eq.sections();
                    let mut at = from;
                    while at < to {
                        let end = (at + CHUNK as u64).min(to);
                        let len = (end - at) as usize * OUT_CHANNELS;
                        let buf = &mut self.scratch[..len];
                        buf.fill(0.0);
                        for clip in &track.clips {
                            mix_clip(clip, at, end, buf, 1.0, 1.0);
                        }
                        for (slot, sec) in sections.iter().enumerate() {
                            let Some(sec) = sec else { continue };
                            let z = &mut st.z[slot];
                            for f in buf.chunks_exact_mut(OUT_CHANNELS) {
                                f[0] = sec.tick(f[0] as f64, &mut z[0]) as f32;
                                f[1] = sec.tick(f[1] as f64, &mut z[1]) as f32;
                            }
                        }
                        if let Some(sink) = tap.as_deref_mut() {
                            for f in buf.chunks_exact(OUT_CHANNELS) {
                                // A full ring drops samples; the analyser
                                // only needs the latest.
                                let _ = sink.push(0.5 * (f[0] + f[1]));
                            }
                        }
                        let base = (at - from) as usize * OUT_CHANNELS;
                        for (i, f) in buf.chunks_exact(OUT_CHANNELS).enumerate() {
                            let (l, r) = (f[0] * gl, f[1] * gr);
                            out[base + i * OUT_CHANNELS] += l;
                            out[base + i * OUT_CHANNELS + 1] += r;
                            pl = pl.max(l.abs());
                            pr = pr.max(r.abs());
                        }
                        at = end;
                    }
                }
                None => {
                    for clip in &track.clips {
                        let (l, r) = mix_clip(clip, from, to, out, gl, gr);
                        pl = pl.max(l);
                        pr = pr.max(r);
                    }
                }
            }
            if let Some(p) = self.peaks.get_mut(n) {
                p[0] = p[0].max(pl);
                p[1] = p[1].max(pr);
            }
        }
        self.pos = to;
    }
}

/// Adds `clip`'s timeline frames `from..to` into `out` (interleaved stereo
/// from `from`), times `gl` and `gr`. Returns the peak per side.
#[inline]
fn mix_clip(clip: &Clip, from: u64, to: u64, out: &mut [f32], gl: f32, gr: f32) -> (f32, f32) {
    let (mut pl, mut pr) = (0.0f32, 0.0f32);
    let start = clip.start.max(from);
    let end = clip.end().min(to);
    if start >= end {
        return (pl, pr);
    }
    let unity = clip.is_unity();
    for t in start..end {
        let rel = t - clip.start;
        let (l, r) = clip.frame(rel);
        let g = if unity { 1.0 } else { clip.gain_at(rel) as f32 };
        let i = (t - from) as usize * OUT_CHANNELS;
        let (l, r) = (l * (g * gl), r * (g * gr));
        out[i] += l;
        out[i + 1] += r;
        pl = pl.max(l.abs());
        pr = pr.max(r.abs());
    }
    (pl, pr)
}

/// Offline render of `frames` frames from `start`, through the same path as
/// playback.
pub fn render(project: Arc<Project>, start: u64, frames: usize) -> Vec<f32> {
    let mut out = vec![0.0; frames * OUT_CHANNELS];
    Renderer::new(project, start).process(&mut out);
    out
}
