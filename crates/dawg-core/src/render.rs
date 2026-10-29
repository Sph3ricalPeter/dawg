use std::sync::Arc;

use crate::model::Project;

/// The mixer always renders interleaved stereo.
pub const OUT_CHANNELS: usize = 2;

/// Tracks with a level meter; later ones play but aren't metered.
pub const METER_TRACKS: usize = 64;

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
}

impl Renderer {
    pub fn new(project: Arc<Project>, pos: u64) -> Self {
        Self {
            project,
            pos,
            peaks: [[0.0; 2]; METER_TRACKS],
        }
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

    pub fn seek(&mut self, pos: u64) {
        self.pos = pos;
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
            for clip in &track.clips {
                let start = clip.start.max(from);
                let end = clip.end().min(to);
                if start >= end {
                    continue;
                }
                let unity = clip.is_unity();
                for t in start..end {
                    let rel = t - clip.start;
                    let (l, r) = clip.source.frame(clip.offset + rel);
                    let g = if unity { 1.0 } else { clip.gain_at(rel) as f32 };
                    let i = (t - from) as usize * OUT_CHANNELS;
                    let (l, r) = (l * (g * gl), r * (g * gr));
                    out[i] += l;
                    out[i + 1] += r;
                    pl = pl.max(l.abs());
                    pr = pr.max(r.abs());
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

/// Offline render of `frames` frames from `start`, through the same path as
/// playback.
pub fn render(project: Arc<Project>, start: u64, frames: usize) -> Vec<f32> {
    let mut out = vec![0.0; frames * OUT_CHANNELS];
    Renderer::new(project, start).process(&mut out);
    out
}
