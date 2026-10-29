use std::sync::Arc;

use crate::model::Project;

/// The mixer always renders interleaved stereo.
pub const OUT_CHANNELS: usize = 2;

/// Plays a project from a position, one buffer at a time.
///
/// [`Renderer::process`] runs on the audio thread: it must never allocate,
/// lock or block. `tests/realtime.rs` enforces the allocation rule.
pub struct Renderer {
    project: Arc<Project>,
    pos: u64,
}

impl Renderer {
    pub fn new(project: Arc<Project>, pos: u64) -> Self {
        Self { project, pos }
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
        for track in &self.project.tracks {
            if track.muted || (any_solo && !track.solo) {
                continue;
            }
            let (gl, gr) = track.side_gains();
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
                    out[i] += l * (g * gl);
                    out[i + 1] += r * (g * gr);
                }
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
