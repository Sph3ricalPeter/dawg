use std::sync::Arc;

use crate::eq::{Biquad, MAX_SECTIONS};
use crate::model::{Clip, Project, Track};

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

/// How long a track whose clips changed (moved, trimmed, stretched, an
/// envelope or fade edited, added or removed) crossfades from the old clips
/// to the new ones. A clip jumping under the playhead is a step in the
/// waveform, like a seek.
pub const EDIT_FADE_SECONDS: f64 = 0.02;

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
/// solo, clip gain and master volume ramp over [`RAMP_SECONDS`], a changed
/// EQ crossfades over [`EQ_FADE_SECONDS`], and a track whose clips sound
/// different (moved, trimmed, stretched, faded, enveloped, added, removed,
/// or the track itself added or deleted) crossfades from the old clips to
/// the new ones over [`EDIT_FADE_SECONDS`], before its EQ so the filters run
/// on without a break. Values that hold still render exactly as without the
/// ramps.
pub struct Renderer {
    project: Arc<Project>,
    /// The snapshot being crossfaded from, while one is.
    from: Option<Arc<Project>>,
    /// A snapshot that came in mid-crossfade: the next one fades to it. A
    /// newer one replaces it unheard.
    next: Option<Arc<Project>>,
    /// Frames left of the crossfade from `from`, and its whole length.
    edit_left: u32,
    edit_whole: u32,
    /// Snapshots done with, for [`Renderer::released`] to hand back.
    released: [Option<Arc<Project>>; RELEASED],
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
    /// A track's old clips summed, while they crossfade to the new ones.
    prev: Box<[f32; CHUNK * OUT_CHANNELS]>,
    /// Where one track's sound after its EQ goes, mono, for the analyser.
    tap: Option<rtrb::Producer<f32>>,
    /// The track tapped; [`NO_TAP`] for none.
    tap_track: u64,
}

/// Room for snapshots awaiting release: more than one block can finish.
const RELEASED: usize = 4;

/// What one track mixes this block.
struct TrackMix<'a> {
    /// Its volume, pan, mute, solo and EQ.
    track: &'a Track,
    /// The clips heard once any crossfade is over.
    clips: &'a [Clip],
    /// The clips being crossfaded from, while they sound different.
    old: Option<&'a [Clip]>,
    /// Metered and tapped: false for a deleted track fading out.
    shown: bool,
}

/// Whether two versions of a track's clips sound the same, gains aside.
fn same_clips(a: &[Clip], b: &[Clip]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.same_sound(y))
}

impl Renderer {
    pub fn new(project: Arc<Project>, pos: u64) -> Self {
        Self {
            project,
            from: None,
            next: None,
            edit_left: 0,
            edit_whole: 1,
            released: std::array::from_fn(|_| None),
            pos,
            peaks: [[0.0; 2]; METER_TRACKS],
            tracks: (0..METER_TRACKS).map(|_| TrackState::new()).collect(),
            master: Ramp::at(1.0),
            settle: true,
            blocks: 0,
            scratch: Box::new([0.0; CHUNK * OUT_CHANNELS]),
            alt: Box::new([0.0; CHUNK * OUT_CHANNELS]),
            prev: Box::new([0.0; CHUNK * OUT_CHANNELS]),
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

    /// Starts the next block at the project's values, with no ramps or
    /// crossfades from what played before: for starting from silence.
    pub fn settle(&mut self) {
        self.settle = true;
    }

    /// The newest snapshot: the one heard once any crossfade is over.
    pub fn project(&self) -> &Arc<Project> {
        self.next.as_ref().unwrap_or(&self.project)
    }

    /// Plays `project` from now on, crossfading to it where its clips sound
    /// different. Hands back a snapshot that is done with, if any (one that
    /// came in mid-crossfade and was never heard), so the caller decides
    /// which thread frees it; the rest come back from
    /// [`Renderer::released`].
    pub fn swap_project(&mut self, project: Arc<Project>) -> Option<Arc<Project>> {
        if self.from.is_none() {
            self.begin_edit(project);
            None
        } else {
            self.next.replace(project)
        }
    }

    /// Plays `project` from the next block with no crossfade, as from
    /// silence. The previous snapshots come back from
    /// [`Renderer::released`].
    pub fn cut_to(&mut self, project: Arc<Project>) {
        self.end_edit();
        let old = std::mem::replace(&mut self.project, project);
        self.release(old);
        self.arrange();
        self.settle = true;
    }

    /// A snapshot the renderer is done with, to free off the audio thread.
    /// Call until `None` after each [`Renderer::process`].
    pub fn released(&mut self) -> Option<Arc<Project>> {
        self.released.iter_mut().find_map(Option::take)
    }

    fn release(&mut self, p: Arc<Project>) {
        match self.released.iter_mut().find(|s| s.is_none()) {
            Some(slot) => *slot = Some(p),
            // Never free here; can't happen while the caller collects.
            None => std::mem::forget(p),
        }
    }

    /// Starts the crossfade from the current snapshot to `project`.
    fn begin_edit(&mut self, project: Arc<Project>) {
        let rate = project.sample_rate as f64;
        self.from = Some(std::mem::replace(&mut self.project, project));
        self.edit_whole = (EDIT_FADE_SECONDS * rate).round().max(1.0) as u32;
        self.edit_left = self.edit_whole;
        self.arrange();
    }

    /// Ends any crossfade at once, on the newest snapshot.
    fn end_edit(&mut self) {
        if let Some(next) = self.next.take() {
            let old = std::mem::replace(&mut self.project, next);
            self.release(old);
        }
        if let Some(from) = self.from.take() {
            self.release(from);
        }
        self.edit_left = 0;
        self.arrange();
    }

    /// Moves each track's mix state to the slot of its index in the current
    /// snapshot, followed by tracks deleted since `from`, so deleting or
    /// moving a track doesn't restart the others' ramps and filters.
    fn arrange(&mut self) {
        let mut ids = [u64::MAX; METER_TRACKS];
        let mut n = 0;
        for t in self.project.tracks.iter().take(METER_TRACKS) {
            ids[n] = t.id;
            n += 1;
        }
        if let Some(from) = &self.from {
            for t in &from.tracks {
                if n == METER_TRACKS {
                    break;
                }
                if !self.project.tracks.iter().any(|x| x.id == t.id) {
                    ids[n] = t.id;
                    n += 1;
                }
            }
        }
        let ids = &ids[..n];
        for k in 0..n {
            if let Some(j) = (k..self.tracks.len()).find(|&j| self.tracks[j].track == ids[k]) {
                self.tracks.swap(k, j);
                continue;
            }
            // No state for this track: don't let it take one that a later
            // track still needs.
            while let Some(m) = (k + 1..n)
                .find(|&m| ids[m] == self.tracks[k].track && self.tracks[m].track != ids[m])
            {
                self.tracks.swap(k, m);
            }
        }
    }

    /// Fills `out` (interleaved stereo) with the next frames and advances.
    pub fn process(&mut self, out: &mut [f32]) {
        debug_assert_eq!(out.len() % OUT_CHANNELS, 0);
        out.fill(0.0);
        let frames = (out.len() / OUT_CHANNELS) as u64;
        let (from, to) = (self.pos, self.pos + frames);
        let settle = std::mem::take(&mut self.settle);
        if settle && self.from.is_some() {
            self.end_edit();
        }
        self.blocks += 1;
        let rate = self.project.sample_rate as f64;
        let ramp = if settle {
            0
        } else {
            (RAMP_SECONDS * rate).round() as u32
        };

        // Clones of the snapshots (no allocation) so the tracks can be
        // borrowed while mixing.
        let project = self.project.clone();
        let old = self.from.clone();
        let any_solo = project.tracks.iter().any(|t| t.solo);
        for (n, track) in project.tracks.iter().enumerate() {
            if n >= METER_TRACKS {
                // Past the metered tracks: no EQ and no smoothing.
                let silent = track.muted || (any_solo && !track.solo);
                if !silent {
                    let (gl, gr) = track.side_gains();
                    for clip in &track.clips {
                        mix_clip(clip, from, to, out, gl, gr, None);
                    }
                }
                continue;
            }
            let was = old
                .as_ref()
                .map(|p| p.tracks.iter().find(|t| t.id == track.id));
            let old_clips = match was {
                None => None,
                Some(Some(t)) if same_clips(&t.clips, &track.clips) => None,
                Some(Some(t)) => Some(&t.clips[..]),
                // A new track fades in.
                Some(None) => Some(&[][..]),
            };
            let mix = TrackMix {
                track,
                clips: &track.clips,
                old: old_clips,
                shown: true,
            };
            self.mix_track(n, mix, any_solo, settle, ramp, from, to, out);
        }
        // Deleted tracks fade out, through their EQ and at their volume.
        if let Some(old) = &old {
            let mut n = project.tracks.len();
            for track in &old.tracks {
                if n >= METER_TRACKS {
                    break;
                }
                if project.tracks.iter().any(|t| t.id == track.id) {
                    continue;
                }
                let mix = TrackMix {
                    track,
                    clips: &[],
                    old: Some(&track.clips),
                    shown: false,
                };
                self.mix_track(n, mix, any_solo, settle, ramp, from, to, out);
                n += 1;
            }
        }

        if settle {
            self.master.jump(project.master_gain);
        } else {
            self.master.set(project.master_gain, ramp);
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
        drop(project);
        drop(old);
        if self.from.is_some() {
            self.edit_left = self
                .edit_left
                .saturating_sub(frames.min(u32::MAX as u64) as u32);
            if self.edit_left == 0 {
                if let Some(done) = self.from.take() {
                    self.release(done);
                }
                if let Some(next) = self.next.take() {
                    self.begin_edit(next);
                }
            }
        }
    }

    /// Mixes one track's frames `from..to` into `out`, in mix state slot `n`.
    #[allow(clippy::too_many_arguments)]
    fn mix_track(
        &mut self,
        n: usize,
        mix: TrackMix,
        any_solo: bool,
        settle: bool,
        ramp: u32,
        from: u64,
        to: u64,
        out: &mut [f32],
    ) {
        let TrackMix {
            track,
            clips,
            old,
            shown,
        } = mix;
        let block = self.blocks;
        let rate = self.project.sample_rate as f64;
        let eq_fade = (EQ_FADE_SECONDS * rate).round().max(1.0) as u32;
        let silent = track.muted || (any_solo && !track.solo);
        let target = if silent {
            (0.0, 0.0)
        } else {
            track.side_gains()
        };
        let sections = track.eq.sections();
        let st = &mut self.tracks[n];
        if settle || st.track != track.id {
            st.reset(track.id, target, sections);
        } else {
            st.gain[0].set(target.0, ramp);
            st.gain[1].set(target.1, ramp);
        }
        let ramping = st.gain[0].moving() || st.gain[1].moving();
        if silent && !ramping {
            st.idle = true;
            return;
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
        let mut tap = self
            .tap
            .as_mut()
            .filter(|_| shown && self.tap_track == track.id);
        let (edit_left, edit_whole) = (self.edit_left as u64, self.edit_whole as f32);
        if st.eq_len > 0 || st.fade_left > 0 || tap.is_some() || ramping || old.is_some() {
            let mut at = from;
            while at < to {
                let end = (at + CHUNK as u64).min(to);
                let len = (end - at) as usize * OUT_CHANNELS;
                let buf = &mut self.scratch[..len];
                buf.fill(0.0);
                for clip in clips {
                    if clip.start >= end || clip.end() <= at {
                        continue;
                    }
                    let g = st.clip_gain(clip, block, ramp);
                    mix_clip(clip, at, end, buf, 1.0, 1.0, Some(g));
                }
                if let Some(old) = old {
                    // From the old clips to the new, in a straight line.
                    let prev = &mut self.prev[..len];
                    prev.fill(0.0);
                    for clip in old {
                        mix_clip(clip, at, end, prev, 1.0, 1.0, None);
                    }
                    let fs = buf.as_chunks_mut::<OUT_CHANNELS>().0;
                    let done = from + edit_left;
                    for (t, (f, o)) in
                        (at..end).zip(fs.iter_mut().zip(prev.as_chunks::<OUT_CHANNELS>().0))
                    {
                        if t >= done {
                            break;
                        }
                        let w = 1.0 - (done - t) as f32 / edit_whole;
                        f[0] = o[0] + (f[0] - o[0]) * w;
                        f[1] = o[1] + (f[1] - o[1]) * w;
                    }
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
            for clip in clips {
                if clip.start >= to || clip.end() <= from {
                    continue;
                }
                let g = st.clip_gain(clip, block, ramp);
                let (l, r) = mix_clip(clip, from, to, out, gl, gr, Some(g));
                pl = pl.max(l);
                pr = pr.max(r);
            }
        }
        if shown {
            let p = &mut self.peaks[n];
            p[0] = p[0].max(pl);
            p[1] = p[1].max(pr);
        }
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
            // The same source, so only the gain changed.
            let a = project(false);
            let mut b = a.clone();
            edit(&mut b);
            let out = change(a.clone(), b.clone(), 2048);
            let left = side(&out, 0);
            assert!(max_step(&left, 0.5) <= 0.5 / RAMP as f32 * 1.01, "edit {n}");
            assert_eq!(left[RAMP + 1], 0.0, "edit {n}");
            // And back again.
            let back = change(b, a, 2048);
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

    const EDIT: usize = (EDIT_FADE_SECONDS * RATE as f64) as usize;

    #[test]
    fn moving_a_clip_under_the_playhead_crossfades() {
        // Moved away, so the playhead (at 512) lands in silence.
        let a = project(false);
        let mut b = a.clone();
        b.tracks[0].clips[0].start = 10 * RATE as u64;
        let left = side(&change(a.clone(), b.clone(), 2048), 0);
        assert!(max_step(&left, 0.5) <= 0.5 / EDIT as f32 * 1.01);
        assert!(left[0] > 0.49);
        assert_eq!(left[EDIT], 0.0);
        // And back under it: fades in, then plays exactly as rendered.
        let left = side(&change(b, a.clone(), 2048), 0);
        assert!(max_step(&left, 0.0) <= 0.5 / EDIT as f32 * 1.01);
        assert_eq!(
            left[EDIT..],
            side(&render(Arc::new(a), 512 + EDIT as u64, 2048 - EDIT), 0)[..]
        );
    }

    #[test]
    fn trims_envelopes_and_stretches_crossfade() {
        let edits: [fn(&mut Clip); 4] = [
            |c| c.len = 100,
            |c| c.offset = 30_000,
            |c| c.envelope = Arc::new([crate::model::EnvPoint { at: 0, gain: 0.0 }]),
            |c| c.fade_in = 1000,
        ];
        for (n, edit) in edits.iter().enumerate() {
            let a = project(true);
            let mut b = a.clone();
            edit(&mut b.tracks[0].clips[0]);
            let old = side(&render(Arc::new(a.clone()), 0, 512 + 2048), 0);
            let new = side(&render(Arc::new(b.clone()), 0, 512 + 2048), 0);
            let out = side(&change(a, b, 2048), 0);
            // Each frame between the old sound and the new one, never a
            // step from one to the other.
            for (i, &x) in out.iter().enumerate() {
                let w = (i as f32 / EDIT as f32).min(1.0);
                let want = old[512 + i] + (new[512 + i] - old[512 + i]) * w;
                assert!((x - want).abs() < 1e-5, "edit {n} at {i}: {x} vs {want}");
            }
        }
    }

    #[test]
    fn adding_and_deleting_tracks_fades_them() {
        let a = project(false);
        let mut b = a.clone();
        let mut t = b.tracks[0].clone();
        t.id = 2;
        b.tracks.insert(0, t);
        // A new track playing the same: from 0.5 up to 1.0, smoothly.
        let left = side(&change(a.clone(), b.clone(), 2048), 0);
        assert!(max_step(&left, 0.5) <= 0.5 / EDIT as f32 * 1.01);
        assert_eq!(left[EDIT], 1.0);
        // Deleted again: back down.
        let left = side(&change(b, a, 2048), 0);
        assert!(max_step(&left, 1.0) <= 0.5 / EDIT as f32 * 1.01);
        assert_eq!(left[EDIT], 0.5);
    }

    #[test]
    fn deleting_a_track_leaves_the_others_filters_running() {
        let band = EqBand {
            kind: BandKind::LowCut,
            freq: 4000.0,
            gain_db: 0.0,
            q: std::f32::consts::FRAC_1_SQRT_2,
            slope: 48,
            on: true,
        };
        let mut kept = project(true);
        kept.tracks[0].id = 2;
        kept.tracks[0].eq = Eq::new(&[band], false, RATE);
        let mut a = project(false);
        a.tracks[0].muted = true;
        a.tracks.push(kept.tracks[0].clone());
        // Track 2 moves from slot 1 to slot 0 and plays on as if alone.
        let out = change(a, kept.clone(), 2048);
        let alone = render(Arc::new(kept), 0, 512 + 2048);
        assert_eq!(out[..], alone[512 * OUT_CHANNELS..]);
    }

    #[test]
    fn edits_mid_crossfade_queue_up() {
        // Dragged back and forth faster than a crossfade.
        let a = project(false);
        let mut b = a.clone();
        b.tracks[0].clips[0].start = 10 * RATE as u64;
        let mut r = Renderer::new(Arc::new(a.clone()), 0);
        let mut buf = vec![0.0; 64 * OUT_CHANNELS];
        r.process(&mut buf);
        let mut left = Vec::new();
        let mut freed = 0;
        for i in 0..200 {
            let p = if i % 2 == 0 { &b } else { &a };
            freed += r.swap_project(Arc::new(p.clone())).is_some() as usize;
            r.process(&mut buf);
            while r.released().is_some() {
                freed += 1;
            }
            left.extend(side(&buf, 0));
        }
        assert!(max_step(&left, 0.5) <= 0.5 / EDIT as f32 * 1.01);
        // Every snapshot came back but the one playing and any the
        // crossfade still holds.
        let held = r.from.is_some() as usize + r.next.is_some() as usize;
        assert_eq!(freed + held, 200);
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
