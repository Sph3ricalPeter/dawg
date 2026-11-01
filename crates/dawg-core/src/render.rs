use std::sync::Arc;

use crate::eq::{Biquad, MAX_SECTIONS};
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

/// How long a change to a track's volume, pan, mute or solo, a clip's gain
/// or the master volume takes to reach the new value. A step in a gain is a
/// step in the waveform, heard as a click; a short ramp hides it.
pub const RAMP_SECONDS: f64 = 0.02;

/// How long a changed EQ crossfades from the old filters to the new ones.
pub const EQ_FADE_SECONDS: f64 = 0.02;

/// Clips per track whose gain changes are smoothed: more than the clips that
/// overlap at once in practice.
const CLIP_RAMPS: usize = 8;

/// No clip in a [`ClipRamp`] slot.
const NO_CLIP: u64 = u64::MAX;

/// A value that follows its target in a straight line over a set number of
/// frames, then sits on it exactly.
#[derive(Clone, Copy, Debug)]
struct Ramp {
    cur: f32,
    target: f32,
    step: f32,
    left: u32,
}

impl Ramp {
    const fn at(v: f32) -> Self {
        Self {
            cur: v,
            target: v,
            step: 0.0,
            left: 0,
        }
    }

    /// Heads for `target` over `frames` from where it is now.
    #[inline]
    fn set(&mut self, target: f32, frames: u32) {
        if target == self.target {
            return;
        }
        self.target = target;
        if frames == 0 {
            self.jump(target);
            return;
        }
        self.step = (target - self.cur) / frames as f32;
        self.left = frames;
    }

    #[inline]
    fn jump(&mut self, v: f32) {
        *self = Self::at(v);
    }

    #[inline]
    fn moving(&self) -> bool {
        self.left > 0
    }

    /// The value for the next frame.
    #[inline]
    fn next(&mut self) -> f32 {
        if self.left > 0 {
            self.left -= 1;
            self.cur = if self.left == 0 {
                self.target
            } else {
                self.cur + self.step
            };
        }
        self.cur
    }
}

/// One clip's smoothed gain.
#[derive(Clone, Copy)]
struct ClipRamp {
    clip: u64,
    /// Block it was last heard in, to pick a slot to reuse.
    seen: u64,
    gain: Ramp,
}

type Sections = [Option<Biquad>; MAX_SECTIONS];
type Filter = [[[f64; 2]; 2]; MAX_SECTIONS];

/// What one track's mix remembers between blocks: its smoothed gains and its
/// EQ's filters and state.
struct TrackState {
    /// The track the state belongs to; another track in this slot starts
    /// afresh, with no ramps.
    track: u64,
    /// Silent (muted or soloed out) and skipped: its filter state is stale.
    idle: bool,
    /// Left and right gain: volume and pan, 0 while silent.
    gain: [Ramp; 2],
    /// The EQ's sections as heard, and how many slots are in use.
    eq: Box<Sections>,
    eq_len: usize,
    z: Box<Filter>,
    /// While crossfading after an EQ change, the old sections and their
    /// state, and frames left.
    from: Box<Sections>,
    from_len: usize,
    zf: Box<Filter>,
    fade_left: u32,
    clips: [ClipRamp; CLIP_RAMPS],
}

impl TrackState {
    fn new() -> Self {
        Self {
            track: 0,
            idle: false,
            gain: [Ramp::at(0.0); 2],
            eq: Box::new([None; MAX_SECTIONS]),
            eq_len: 0,
            z: Box::new([[[0.0; 2]; 2]; MAX_SECTIONS]),
            from: Box::new([None; MAX_SECTIONS]),
            from_len: 0,
            zf: Box::new([[[0.0; 2]; 2]; MAX_SECTIONS]),
            fade_left: 0,
            clips: [ClipRamp {
                clip: NO_CLIP,
                seen: 0,
                gain: Ramp::at(1.0),
            }; CLIP_RAMPS],
        }
    }

    /// Starts over for `track`: everything at its target, from silence.
    fn reset(&mut self, track: u64, (gl, gr): (f32, f32), sections: &[Option<Biquad>]) {
        self.track = track;
        self.idle = false;
        self.gain = [Ramp::at(gl), Ramp::at(gr)];
        self.set_eq(sections);
        *self.z = [[[0.0; 2]; 2]; MAX_SECTIONS];
        self.fade_left = 0;
        for c in &mut self.clips {
            c.clip = NO_CLIP;
        }
    }

    fn set_eq(&mut self, sections: &[Option<Biquad>]) {
        let n = sections.len().min(MAX_SECTIONS);
        self.eq[..n].copy_from_slice(&sections[..n]);
        self.eq_len = n;
    }

    fn same_eq(&self, sections: &[Option<Biquad>]) -> bool {
        self.eq[..self.eq_len] == *sections
    }

    /// Hears `sections` from now on, crossfading from the current ones.
    fn fade_eq(&mut self, sections: &[Option<Biquad>], frames: u32) {
        self.from_len = self.eq_len;
        self.from[..self.eq_len].copy_from_slice(&self.eq[..self.eq_len]);
        *self.zf = *self.z;
        // A section new to its slot starts from silence; one that changed
        // carries on from the old one's state.
        for (slot, sec) in sections.iter().enumerate() {
            if sec.is_some() && (slot >= self.eq_len || self.eq[slot].is_none()) {
                self.z[slot] = [[0.0; 2]; 2];
            }
        }
        self.set_eq(sections);
        self.fade_left = frames;
    }

    /// The smoothed gain for `clip`, heading for its current gain.
    fn clip_gain(&mut self, clip: &Clip, block: u64, frames: u32) -> &mut Ramp {
        let i = match self.clips.iter().position(|c| c.clip == clip.id) {
            Some(i) => {
                self.clips[i].gain.set(clip.gain, frames);
                i
            }
            None => {
                // A clip not heard lately starts at its gain.
                let i = (0..CLIP_RAMPS)
                    .min_by_key(|&i| self.clips[i].seen)
                    .unwrap_or(0);
                self.clips[i].clip = clip.id;
                self.clips[i].gain.jump(clip.gain);
                i
            }
        };
        self.clips[i].seen = block;
        &mut self.clips[i].gain
    }
}

/// Runs `buf` (interleaved stereo) through `sections` with state `z`.
#[inline]
fn run_eq(sections: &[Option<Biquad>], z: &mut Filter, buf: &mut [f32]) {
    for (slot, sec) in sections.iter().enumerate() {
        let Some(sec) = sec else { continue };
        let z = &mut z[slot];
        for f in buf.as_chunks_mut::<OUT_CHANNELS>().0 {
            f[0] = sec.tick(f[0] as f64, &mut z[0]) as f32;
            f[1] = sec.tick(f[1] as f64, &mut z[1]) as f32;
        }
    }
}

/// Plays a project from a position, one buffer at a time.
///
/// [`Renderer::process`] runs on the audio thread: it must never allocate,
/// lock or block. `tests/realtime.rs` enforces the allocation rule.
///
/// A new snapshot doesn't step the sound: changes to volume, pan, mute,
/// solo, clip gain and master volume ramp over [`RAMP_SECONDS`], and a
/// changed EQ crossfades over [`EQ_FADE_SECONDS`]. Values that hold still
/// render exactly as without the ramps.
pub struct Renderer {
    project: Arc<Project>,
    pos: u64,
    /// Peak level per track (by index) and side since the last
    /// [`Renderer::take_peaks`], after the track's volume and pan.
    peaks: [[f32; 2]; METER_TRACKS],
    /// Mix state per track (by index), allocated up front.
    tracks: Box<[TrackState]>,
    master: Ramp,
    /// The next block jumps straight to every value instead of ramping.
    settle: bool,
    /// Blocks rendered, to age clip ramps.
    blocks: u64,
    /// A track's clips summed, before its EQ.
    scratch: Box<[f32; CHUNK * OUT_CHANNELS]>,
    /// The same through the old EQ, while it crossfades to a new one.
    alt: Box<[f32; CHUNK * OUT_CHANNELS]>,
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
            tracks: (0..METER_TRACKS).map(|_| TrackState::new()).collect(),
            master: Ramp::at(1.0),
            settle: true,
            blocks: 0,
            scratch: Box::new([0.0; CHUNK * OUT_CHANNELS]),
            alt: Box::new([0.0; CHUNK * OUT_CHANNELS]),
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
        for st in self.tracks.iter_mut() {
            *st.z = [[[0.0; 2]; 2]; MAX_SECTIONS];
            st.fade_left = 0;
        }
    }

    /// Starts the next block at the project's values, with no ramps from
    /// what played before: for starting from silence.
    pub fn settle(&mut self) {
        self.settle = true;
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
        let settle = std::mem::take(&mut self.settle);
        self.blocks += 1;
        let block = self.blocks;
        let rate = self.project.sample_rate as f64;
        let ramp = if settle {
            0
        } else {
            (RAMP_SECONDS * rate).round() as u32
        };
        let eq_fade = (EQ_FADE_SECONDS * rate).round().max(1.0) as u32;

        let any_solo = self.project.tracks.iter().any(|t| t.solo);
        for (n, track) in self.project.tracks.iter().enumerate() {
            let silent = track.muted || (any_solo && !track.solo);
            let target = if silent {
                (0.0, 0.0)
            } else {
                track.side_gains()
            };
            let sections = track.eq.sections();
            let Some(st) = self.tracks.get_mut(n) else {
                // Past the metered tracks: no EQ and no smoothing.
                if !silent {
                    for clip in &track.clips {
                        mix_clip(clip, from, to, out, target.0, target.1, None);
                    }
                }
                continue;
            };
            if settle || st.track != track.id {
                st.reset(track.id, target, sections);
            } else {
                st.gain[0].set(target.0, ramp);
                st.gain[1].set(target.1, ramp);
            }
            let ramping = st.gain[0].moving() || st.gain[1].moving();
            if silent && !ramping {
                st.idle = true;
                continue;
            }
            if st.idle {
                // Back from silence, fading in from 0: no old EQ to fade from.
                st.idle = false;
                st.set_eq(sections);
                *st.z = [[[0.0; 2]; 2]; MAX_SECTIONS];
                st.fade_left = 0;
            } else if st.fade_left == 0 && !st.same_eq(sections) {
                // A change mid-crossfade waits for it to finish.
                st.fade_eq(sections, eq_fade);
            }

            let (mut pl, mut pr) = (0.0f32, 0.0f32);
            let mut tap = self.tap.as_mut().filter(|_| self.tap_track == track.id);
            if st.eq_len > 0 || st.fade_left > 0 || tap.is_some() || ramping {
                let mut at = from;
                while at < to {
                    let end = (at + CHUNK as u64).min(to);
                    let len = (end - at) as usize * OUT_CHANNELS;
                    let buf = &mut self.scratch[..len];
                    buf.fill(0.0);
                    for clip in &track.clips {
                        if clip.start >= end || clip.end() <= at {
                            continue;
                        }
                        let g = st.clip_gain(clip, block, ramp);
                        mix_clip(clip, at, end, buf, 1.0, 1.0, Some(g));
                    }
                    if st.fade_left > 0 {
                        let alt = &mut self.alt[..len];
                        alt.copy_from_slice(buf);
                        run_eq(&st.from[..st.from_len], &mut st.zf, alt);
                        run_eq(&st.eq[..st.eq_len], &mut st.z, buf);
                        let whole = eq_fade as f32;
                        let fs = buf.as_chunks_mut::<OUT_CHANNELS>().0;
                        for (f, o) in fs.iter_mut().zip(alt.as_chunks::<OUT_CHANNELS>().0) {
                            if st.fade_left == 0 {
                                break;
                            }
                            st.fade_left -= 1;
                            let w = 1.0 - st.fade_left as f32 / whole;
                            f[0] = o[0] + (f[0] - o[0]) * w;
                            f[1] = o[1] + (f[1] - o[1]) * w;
                        }
                    } else {
                        run_eq(&st.eq[..st.eq_len], &mut st.z, buf);
                    }
                    if let Some(sink) = tap.as_deref_mut() {
                        for f in buf.as_chunks::<OUT_CHANNELS>().0 {
                            // A full ring drops samples; the analyser
                            // only needs the latest.
                            let _ = sink.push(0.5 * (f[0] + f[1]));
                        }
                    }
                    let base = (at - from) as usize * OUT_CHANNELS;
                    let fs = buf.as_chunks::<OUT_CHANNELS>().0;
                    for (i, f) in fs.iter().enumerate() {
                        let (gl, gr) = (st.gain[0].next(), st.gain[1].next());
                        let (l, r) = (f[0] * gl, f[1] * gr);
                        out[base + i * OUT_CHANNELS] += l;
                        out[base + i * OUT_CHANNELS + 1] += r;
                        pl = pl.max(l.abs());
                        pr = pr.max(r.abs());
                    }
                    at = end;
                }
                if silent && !(st.gain[0].moving() || st.gain[1].moving()) {
                    st.idle = true;
                }
            } else {
                let (gl, gr) = (st.gain[0].cur, st.gain[1].cur);
                for clip in &track.clips {
                    if clip.start >= to || clip.end() <= from {
                        continue;
                    }
                    let g = st.clip_gain(clip, block, ramp);
                    let (l, r) = mix_clip(clip, from, to, out, gl, gr, Some(g));
                    pl = pl.max(l);
                    pr = pr.max(r);
                }
            }
            if let Some(p) = self.peaks.get_mut(n) {
                p[0] = p[0].max(pl);
                p[1] = p[1].max(pr);
            }
        }

        if settle {
            self.master.jump(self.project.master_gain);
        } else {
            self.master.set(self.project.master_gain, ramp);
        }
        if self.master.moving() {
            for f in out.as_chunks_mut::<OUT_CHANNELS>().0 {
                let g = self.master.next();
                f[0] *= g;
                f[1] *= g;
            }
        } else if self.master.cur != 1.0 {
            let master = self.master.cur;
            for x in out.iter_mut() {
                *x *= master;
            }
        }
        self.pos = to;
    }
}

/// Adds `clip`'s timeline frames `from..to` into `out` (interleaved stereo
/// from `from`), times `gl` and `gr`, with the clip's gain taken from `ramp`
/// while that moves. Returns the peak per side.
#[inline]
fn mix_clip(
    clip: &Clip,
    from: u64,
    to: u64,
    out: &mut [f32],
    gl: f32,
    gr: f32,
    mut ramp: Option<&mut Ramp>,
) -> (f32, f32) {
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
        let g = match ramp.as_deref_mut().filter(|r| r.moving()) {
            Some(ramp) => {
                let g = ramp.next() as f64;
                (g * clip.fade_at(rel) * clip.envelope_at(clip.source_at(rel))) as f32
            }
            None if unity => 1.0,
            None => clip.gain_at(rel) as f32,
        };
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eq::{BandKind, Eq, EqBand};
    use crate::model::{Source, Track};

    const RATE: u32 = 48_000;
    const RAMP: usize = (RAMP_SECONDS * RATE as f64) as usize;

    /// One track playing a steady 0.5 (or a square wave) for a second.
    fn project(square: bool) -> Project {
        let samples: Vec<f32> = (0..RATE as usize)
            .map(|i| if !square || i % 48 < 24 { 0.5 } else { -0.5 })
            .collect();
        Project::with_tracks(
            RATE,
            vec![Track {
                id: 1,
                clips: vec![Clip::new(Arc::new(Source::new(1, samples)), 0)],
                ..Track::default()
            }],
        )
    }

    /// Renders 512 frames of `a`, then `frames` of `b` from where `a` left.
    fn change(a: Project, b: Project, frames: usize) -> Vec<f32> {
        let mut r = Renderer::new(Arc::new(a), 0);
        let mut buf = vec![0.0; 512 * OUT_CHANNELS];
        r.process(&mut buf);
        r.swap_project(Arc::new(b));
        let mut out = vec![0.0; frames * OUT_CHANNELS];
        for c in out.chunks_mut(256 * OUT_CHANNELS) {
            r.process(c);
        }
        out
    }

    fn side(out: &[f32], c: usize) -> Vec<f32> {
        out.iter().skip(c).step_by(OUT_CHANNELS).copied().collect()
    }

    fn max_step(x: &[f32], before: f32) -> f32 {
        let mut prev = before;
        x.iter().fold(0.0f32, |m, &v| {
            let d = (v - prev).abs();
            prev = v;
            m.max(d)
        })
    }

    #[test]
    fn a_pan_change_ramps_instead_of_stepping() {
        let mut b = project(false);
        b.tracks[0].pan = -1.0;
        let out = change(project(false), b, 2048);
        let right = side(&out, 1);
        // From 0.5 to silence in a straight line, no faster.
        assert!(max_step(&right, 0.5) <= 0.5 / RAMP as f32 * 1.01);
        assert!(right[0] > 0.49);
        assert_eq!(right[RAMP], 0.0);
        assert!(side(&out, 0).iter().all(|&l| l == 0.5));
    }

    #[test]
    fn volume_mute_and_master_ramp() {
        let edits: [fn(&mut Project); 4] = [
            |p| p.tracks[0].gain = 0.0,
            |p| p.tracks[0].muted = true,
            |p| p.master_gain = 0.0,
            |p| p.tracks[0].clips[0].gain = 0.0,
        ];
        for (n, edit) in edits.iter().enumerate() {
            let mut b = project(false);
            edit(&mut b);
            let out = change(project(false), b.clone(), 2048);
            let left = side(&out, 0);
            assert!(max_step(&left, 0.5) <= 0.5 / RAMP as f32 * 1.01, "edit {n}");
            assert_eq!(left[RAMP + 1], 0.0, "edit {n}");
            // And back again.
            let back = change(b, project(false), 2048);
            let left = side(&back, 0);
            assert!(
                max_step(&left, 0.0) <= 0.5 / RAMP as f32 * 1.01,
                "edit {n} back"
            );
            assert_eq!(left[RAMP + 1], 0.5, "edit {n} back");
        }
    }

    #[test]
    fn an_eq_change_crossfades() {
        let band = EqBand {
            kind: BandKind::LowCut,
            freq: 4000.0,
            gain_db: 0.0,
            q: std::f32::consts::FRAC_1_SQRT_2,
            slope: 48,
            on: true,
        };
        let mut b = project(true);
        b.tracks[0].eq = Eq::new(&[band], false, RATE);
        let dry = side(&change(project(true), project(true), 2048), 0);
        let wet = side(&change(b.clone(), b.clone(), 2048), 0);
        let out = side(&change(project(true), b.clone(), 2048), 0);
        // Starts on the dry sound and ends on the filtered one.
        assert!((out[0] - dry[0]).abs() < 0.01);
        let fade = (EQ_FADE_SECONDS * RATE as f64) as usize;
        let tail = fade + 200;
        assert!((out[tail] - wet[tail]).abs() < 1e-3);
        // Turning it off again fades back to dry.
        let off = side(&change(b, project(true), 2048), 0);
        assert!((off[0] - wet[0]).abs() < 0.01);
        assert_eq!(off[fade + 1], dry[fade + 1]);
    }

    #[test]
    fn settling_jumps_straight_to_the_new_values() {
        let mut b = project(false);
        b.tracks[0].pan = -1.0;
        let mut r = Renderer::new(Arc::new(project(false)), 0);
        let mut buf = vec![0.0; 512 * OUT_CHANNELS];
        r.process(&mut buf);
        r.swap_project(Arc::new(b.clone()));
        r.settle();
        r.seek(0);
        r.process(&mut buf);
        assert_eq!(buf, render(Arc::new(b), 0, 512));
    }
}
