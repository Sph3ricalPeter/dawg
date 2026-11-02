use std::sync::Arc;

use crate::device::{CompParams, Device, DeviceParams, UtilityParams, MAX_DEVICES};
use crate::eq::{Biquad, MAX_SECTIONS};
use crate::model::{Clip, Project, Track, MASTER};

/// The mixer always renders interleaved stereo.
pub const OUT_CHANNELS: usize = 2;

/// Channels with a level meter, a chain and sends; later ones play straight
/// into the master, unmetered and without their devices.
pub const METER_TRACKS: usize = 64;

/// Device states the renderer keeps, across every chain and the master's.
/// Devices past this are bypassed.
pub const DEVICE_STATES: usize = 128;

/// Sends one channel keeps smoothed.
const MAX_SENDS: usize = 16;

/// The tap's device id when it listens to none.
pub const NO_TAP: u64 = u64::MAX;

/// Frames the graph renders at a time: every channel runs this much before
/// the channels it sends to.
const CHUNK: usize = 256;
const CHUNK_LEN: usize = CHUNK * OUT_CHANNELS;

/// How long a change to a channel's volume, pan, mute, solo or sends, a
/// clip's gain, a device's settings or bypass, or the master volume takes to
/// reach the new value. A step in a gain is a step in the waveform, heard as
/// a click; a short ramp hides it.
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
/// No channel in a slot, no device in a state.
const NONE: u64 = u64::MAX;
/// No device state.
const NO_STATE: u16 = u16::MAX;

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

/// An EQ device's filters as heard and their state, and while it
/// crossfades after a change, the old ones.
struct EqState {
    eq: Box<Sections>,
    eq_len: usize,
    z: Box<Filter>,
    from: Box<Sections>,
    from_len: usize,
    zf: Box<Filter>,
    fade_left: u32,
}

impl EqState {
    fn new() -> Self {
        Self {
            eq: Box::new([None; MAX_SECTIONS]),
            eq_len: 0,
            z: Box::new([[[0.0; 2]; 2]; MAX_SECTIONS]),
            from: Box::new([None; MAX_SECTIONS]),
            from_len: 0,
            zf: Box::new([[[0.0; 2]; 2]; MAX_SECTIONS]),
            fade_left: 0,
        }
    }

    /// From silence, on `sections`.
    fn reset(&mut self, sections: &[Option<Biquad>]) {
        self.set_eq(sections);
        *self.z = [[[0.0; 2]; 2]; MAX_SECTIONS];
        self.fade_left = 0;
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

    /// Runs `buf` through the EQ, `alt` as scratch.
    fn process(
        &mut self,
        sections: &[Option<Biquad>],
        fade: u32,
        buf: &mut [f32],
        alt: &mut [f32],
    ) {
        let sections = &sections[..sections.len().min(MAX_SECTIONS)];
        if self.fade_left == 0 && !self.same_eq(sections) {
            // A change mid-crossfade waits for it to finish.
            self.fade_eq(sections, fade);
        }
        if self.fade_left > 0 {
            let alt = &mut alt[..buf.len()];
            alt.copy_from_slice(buf);
            run_eq(&self.from[..self.from_len], &mut self.zf, alt);
            run_eq(&self.eq[..self.eq_len], &mut self.z, buf);
            let whole = fade as f32;
            let fs = buf.as_chunks_mut::<OUT_CHANNELS>().0;
            for (f, o) in fs.iter_mut().zip(alt.as_chunks::<OUT_CHANNELS>().0) {
                if self.fade_left == 0 {
                    break;
                }
                self.fade_left -= 1;
                let w = 1.0 - self.fade_left as f32 / whole;
                f[0] = o[0] + (f[0] - o[0]) * w;
                f[1] = o[1] + (f[1] - o[1]) * w;
            }
        } else {
            run_eq(&self.eq[..self.eq_len], &mut self.z, buf);
        }
    }
}

/// A compressor's running state: its gain reduction and smoothed settings.
struct CompState {
    /// Gain reduction in dB, 0 or below.
    gr: f32,
    thr: Ramp,
    ratio: Ramp,
    knee: Ramp,
    makeup: Ramp,
    mix: Ramp,
}

impl CompState {
    fn new() -> Self {
        Self {
            gr: 0.0,
            thr: Ramp::at(0.0),
            ratio: Ramp::at(1.0),
            knee: Ramp::at(0.0),
            makeup: Ramp::at(0.0),
            mix: Ramp::at(1.0),
        }
    }

    fn reset(&mut self, c: &CompParams) {
        self.gr = 0.0;
        self.thr.jump(c.threshold_db);
        self.ratio.jump(c.ratio);
        self.knee.jump(c.knee_db);
        self.makeup.jump(c.makeup_db);
        self.mix.jump(c.mix);
    }

    /// Compresses `buf`, keyed by `key` (the sidechain) or by itself.
    /// Returns the most gain reduction, in dB (0 or below).
    fn process(
        &mut self,
        c: &CompParams,
        rate: f64,
        ramp: u32,
        buf: &mut [f32],
        key: Option<&[f32]>,
    ) -> f32 {
        self.thr.set(c.threshold_db, ramp);
        self.ratio.set(c.ratio, ramp);
        self.knee.set(c.knee_db, ramp);
        self.makeup.set(c.makeup_db, ramp);
        self.mix.set(c.mix, ramp);
        let coef = |ms: f32| (-1.0 / (ms as f64 * 0.001 * rate).max(1.0)).exp() as f32;
        let (att, rel) = (coef(c.attack_ms), coef(c.release_ms));
        let mut most = 0.0f32;
        let frames = buf.as_chunks_mut::<OUT_CHANNELS>().0;
        for (i, f) in frames.iter_mut().enumerate() {
            let (kl, kr) = match key {
                Some(k) => (k[i * 2], k[i * 2 + 1]),
                None => (f[0], f[1]),
            };
            let x = kl.abs().max(kr.abs());
            let xdb = if x > 1e-9 { 20.0 * x.log10() } else { -180.0 };
            let (t, r, w) = (self.thr.next(), self.ratio.next(), self.knee.next());
            let over = xdb - t;
            let target = if 2.0 * over <= -w {
                0.0
            } else if w > 0.0 && 2.0 * over < w {
                let k = over + w / 2.0;
                (1.0 / r - 1.0) * k * k / (2.0 * w)
            } else {
                (1.0 / r - 1.0) * over
            };
            let a = if target < self.gr { att } else { rel };
            self.gr = target + (self.gr - target) * a;
            if self.gr > -1e-6 {
                self.gr = self.gr.min(0.0);
            }
            most = most.min(self.gr);
            let g = db_gain(self.gr + self.makeup.next());
            let mix = self.mix.next();
            let k = 1.0 - mix + mix * g;
            f[0] *= k;
            f[1] *= k;
        }
        most
    }
}

/// Linear gain of `db`, cheaply.
#[inline]
fn db_gain(db: f32) -> f32 {
    (db * (std::f32::consts::LN_10 / 20.0)).exp()
}

/// Utility's smoothed gains and its DC filter's memory.
struct UtilState {
    /// Left and right gain, phase flips included.
    gain: [Ramp; 2],
    /// Side level: 0 mono, 1 as is, 2 twice as wide.
    width: Ramp,
    /// How much of the DC-filtered signal is heard.
    dc: Ramp,
    /// Last input and output per side, for the DC filter.
    dz: [[f64; 2]; 2],
}

impl UtilState {
    fn new() -> Self {
        Self {
            gain: [Ramp::at(1.0); 2],
            width: Ramp::at(1.0),
            dc: Ramp::at(0.0),
            dz: [[0.0; 2]; 2],
        }
    }

    fn targets(u: &UtilityParams) -> ([f32; 2], f32, f32) {
        let g = crate::command::db_to_gain(u.gain_db);
        let sign = |flip: bool| if flip { -g } else { g };
        (
            [sign(u.flip_l), sign(u.flip_r)],
            if u.mono { 0.0 } else { u.width },
            if u.dc { 1.0 } else { 0.0 },
        )
    }

    fn reset(&mut self, u: &UtilityParams) {
        let (g, w, dc) = Self::targets(u);
        self.gain = [Ramp::at(g[0]), Ramp::at(g[1])];
        self.width.jump(w);
        self.dc.jump(dc);
        self.dz = [[0.0; 2]; 2];
    }

    fn process(&mut self, u: &UtilityParams, rate: f64, ramp: u32, buf: &mut [f32]) {
        let (g, w, dc) = Self::targets(u);
        self.gain[0].set(g[0], ramp);
        self.gain[1].set(g[1], ramp);
        self.width.set(w, ramp);
        self.dc.set(dc, ramp);
        let r = 1.0 - 2.0 * std::f64::consts::PI * 5.0 / rate;
        let filter = self.dc.cur > 0.0 || self.dc.moving();
        for f in buf.as_chunks_mut::<OUT_CHANNELS>().0 {
            let width = self.width.next();
            let (mut l, mut rr) = (f[0], f[1]);
            if width != 1.0 {
                let m = 0.5 * (l + rr);
                let s = 0.5 * (l - rr) * width;
                l = m + s;
                rr = m - s;
            }
            if filter {
                let d = self.dc.next();
                for (c, x) in [&mut l, &mut rr].into_iter().enumerate() {
                    let z = &mut self.dz[c];
                    let y = *x as f64 - z[0] + r * z[1];
                    z[0] = *x as f64;
                    z[1] = y;
                    *x += (y as f32 - *x) * d;
                }
            }
            f[0] = l * self.gain[0].next();
            f[1] = rr * self.gain[1].next();
        }
    }
}

/// What one device remembers between blocks.
struct DevState {
    /// The device it belongs to, or [`NONE`] when free.
    device: u64,
    /// How much of the device is heard (0 bypassed, 1 on): bypassing,
    /// adding and removing a device fade it.
    wet: Ramp,
    eq: EqState,
    comp: CompState,
    util: UtilState,
    /// Most gain reduction since the last report, in dB (0 or below).
    gr: f32,
}

impl DevState {
    fn new() -> Self {
        Self {
            device: NONE,
            wet: Ramp::at(0.0),
            eq: EqState::new(),
            comp: CompState::new(),
            util: UtilState::new(),
            gr: 0.0,
        }
    }

    /// From silence, at the device's settings.
    fn reset(&mut self, d: &Device, wet: f32) {
        self.wet.jump(wet);
        self.gr = 0.0;
        match d.params() {
            DeviceParams::Eq { .. } => self.eq.reset(d.eq_filters().sections()),
            DeviceParams::Compressor(c) => self.comp.reset(c),
            DeviceParams::Utility(u) => self.util.reset(u),
        }
    }
}

/// What one channel's mix remembers between blocks: its smoothed gains and
/// sends, and which device states its devices use.
struct ChanState {
    /// The channel the state belongs to; another channel in this slot
    /// starts afresh, with no ramps.
    track: u64,
    /// Silent (muted or soloed out) and skipped: its device state is stale.
    idle: bool,
    /// Left and right gain: volume and pan, 0 while silent.
    gain: [Ramp; 2],
    clips: [ClipRamp; CLIP_RAMPS],
    /// Smoothed sends by destination, `nsends` in use. A removed send
    /// stays until it has faded out.
    sends: [(u64, Ramp); MAX_SENDS],
    nsends: usize,
    /// Device id and its state's index, `ndevs` in use.
    devs: [(u64, u16); MAX_DEVICES * 2],
    ndevs: usize,
}

impl ChanState {
    fn new() -> Self {
        Self {
            track: NONE,
            idle: false,
            gain: [Ramp::at(0.0); 2],
            clips: [ClipRamp {
                clip: NO_CLIP,
                seen: 0,
                gain: Ramp::at(1.0),
            }; CLIP_RAMPS],
            sends: [(NONE, Ramp::at(0.0)); MAX_SENDS],
            nsends: 0,
            devs: [(NONE, NO_STATE); MAX_DEVICES * 2],
            ndevs: 0,
        }
    }

    /// Starts over for `track`: everything at its target, from silence.
    fn reset(&mut self, track: &Track, (gl, gr): (f32, f32)) {
        self.track = track.id;
        self.idle = false;
        self.gain = [Ramp::at(gl), Ramp::at(gr)];
        for c in &mut self.clips {
            c.clip = NO_CLIP;
        }
        self.nsends = 0;
        for s in track.sends.iter().take(MAX_SENDS) {
            self.sends[self.nsends] = (s.to, Ramp::at(s.gain));
            self.nsends += 1;
        }
    }

    /// Follows the channel's sends: each heads for its level, new ones
    /// fade in, removed ones fade out.
    fn follow_sends(&mut self, track: &Track, ramp: u32) {
        for (to, r) in &mut self.sends[..self.nsends] {
            let gain = track
                .sends
                .iter()
                .find(|s| s.to == *to)
                .map_or(0.0, |s| s.gain);
            r.set(gain, ramp);
        }
        for s in &track.sends {
            if self.nsends == MAX_SENDS {
                break;
            }
            if !self.sends[..self.nsends].iter().any(|(to, _)| *to == s.to) {
                let mut r = Ramp::at(0.0);
                r.set(s.gain, ramp);
                self.sends[self.nsends] = (s.to, r);
                self.nsends += 1;
            }
        }
        let mut i = 0;
        while i < self.nsends {
            let r = &self.sends[i].1;
            if r.cur == 0.0 && r.target == 0.0 && !r.moving() {
                self.sends[i] = self.sends[self.nsends - 1];
                self.nsends -= 1;
            } else {
                i += 1;
            }
        }
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

    /// Only the one send, to the master, at exactly unity: the channel can
    /// mix straight into the master.
    fn plain_send(&self) -> bool {
        self.nsends == 1
            && self.sends[0].0 == MASTER
            && self.sends[0].1.cur == 1.0
            && !self.sends[0].1.moving()
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

/// The routing graph of the channels in their slots, worked out on each new
/// snapshot without allocating.
struct Graph {
    /// Channel id per slot, `n` in use: the current snapshot's channels by
    /// index, then channels deleted since the one being crossfaded from.
    ids: [u64; METER_TRACKS],
    n: usize,
    /// Slots in the order they render: every channel after its inputs.
    order: [u8; METER_TRACKS],
    /// Per slot: heard (not muted, and soloed or connected to a solo).
    heard: [bool; METER_TRACKS],
    /// Slots some device sidechains from, so their output is kept.
    keyed: u64,
}

impl Graph {
    fn new() -> Self {
        Self {
            ids: [NONE; METER_TRACKS],
            n: 0,
            order: [0; METER_TRACKS],
            heard: [true; METER_TRACKS],
            keyed: 0,
        }
    }

    fn slot(&self, id: u64) -> Option<usize> {
        if id == MASTER {
            return None;
        }
        self.ids[..self.n].iter().position(|&x| x == id)
    }

    /// Works out the graph for the channels in `ids` (already set), with
    /// edges from both snapshots while one crossfades to the other.
    fn build(&mut self, project: &Project, old: Option<&Project>) {
        let n = self.n;
        // adj[k]: the slots k's signal goes to.
        let mut adj = [0u64; METER_TRACKS];
        self.keyed = 0;
        let add = |g: &mut Graph, t: &Track, adj: &mut [u64; METER_TRACKS]| {
            let Some(k) = g.slot(t.id) else { return };
            for s in &t.sends {
                if let Some(d) = g.slot(s.to) {
                    if d != k {
                        adj[k] |= 1 << d;
                    }
                }
            }
            for d in &t.chain {
                if let Some(src) = d.sidechain.and_then(|id| g.slot(id)) {
                    if src != k {
                        adj[src] |= 1 << k;
                        g.keyed |= 1 << src;
                    }
                }
            }
        };
        for t in &project.tracks {
            add(self, t, &mut adj);
        }
        for d in &project.master_chain {
            if let Some(src) = d.sidechain.and_then(|id| self.slot(id)) {
                self.keyed |= 1 << src;
            }
        }
        if let Some(old) = old {
            for t in &old.tracks {
                add(self, t, &mut adj);
            }
        }
        // Kahn's sort, lowest slot first so a plain project renders in
        // track order. A loop (only possible mid-crossfade, between two
        // snapshots' edges) is broken at its lowest slot.
        let mut indeg = [0u8; METER_TRACKS];
        for &a in &adj[..n] {
            let mut m = a;
            while m != 0 {
                let d = m.trailing_zeros() as usize;
                indeg[d] += 1;
                m &= m - 1;
            }
        }
        let mut done = 0u64;
        for i in 0..n {
            let pick = (0..n)
                .find(|&k| done & (1 << k) == 0 && indeg[k] == 0)
                .or_else(|| (0..n).find(|&k| done & (1 << k) == 0))
                .unwrap_or(0);
            self.order[i] = pick as u8;
            done |= 1 << pick;
            let mut m = adj[pick];
            while m != 0 {
                let d = m.trailing_zeros() as usize;
                indeg[d] = indeg[d].saturating_sub(1);
                m &= m - 1;
            }
        }
        // Solo: a soloed channel, everything it reaches and everything that
        // reaches it, using the current snapshot's edges.
        let mut cur = [0u64; METER_TRACKS];
        for (k, t) in project.tracks.iter().enumerate().take(n.min(METER_TRACKS)) {
            for s in &t.sends {
                if let Some(d) = self.slot(s.to) {
                    cur[k] |= 1 << d;
                }
            }
            for d in &t.chain {
                if let Some(src) = d.sidechain.and_then(|id| self.slot(id)) {
                    cur[src] |= 1 << k;
                }
            }
        }
        let solo: u64 = project
            .tracks
            .iter()
            .take(n)
            .enumerate()
            .filter(|(_, t)| t.solo)
            .fold(0, |m, (k, _)| m | 1 << k);
        let mut down = solo;
        let mut up = solo;
        loop {
            let (d0, u0) = (down, up);
            for (k, &c) in cur[..n].iter().enumerate() {
                if down & (1 << k) != 0 {
                    down |= c;
                }
                if c & up != 0 {
                    up |= 1 << k;
                }
            }
            if down == d0 && up == u0 {
                break;
            }
        }
        let any_solo = project.tracks.iter().any(|t| t.solo);
        for k in 0..n {
            let muted = project
                .tracks
                .get(k)
                .is_none_or(|t| t.muted || t.id != self.ids[k]);
            self.heard[k] = !muted && (!any_solo || (down | up) & (1 << k) != 0);
        }
    }
}

/// The renderer's working buffers.
struct Bufs {
    /// A channel's input, through its chain.
    scratch: Box<[f32; CHUNK_LEN]>,
    /// The same through the old EQ, while it crossfades to a new one.
    alt: Box<[f32; CHUNK_LEN]>,
    /// A channel's old clips summed, while they crossfade to the new ones;
    /// then a device's dry signal while it fades.
    prev: Box<[f32; CHUNK_LEN]>,
    /// Per slot: what other channels sent into it this chunk.
    bus: Box<[[f32; CHUNK_LEN]]>,
    /// Per slot: its output this chunk, for the devices keyed by it.
    post: Box<[[f32; CHUNK_LEN]]>,
    /// Slots with something in `bus`, with `post` set, and rendered, this
    /// chunk.
    fed: u64,
    posted: u64,
    done: u64,
}

/// Silence, for a compressor whose key channel is silent.
static ZEROS: [f32; CHUNK_LEN] = [0.0; CHUNK_LEN];

/// What devices need while they run.
struct Ctx<'a> {
    devs: &'a mut [DevState],
    alt: &'a mut [f32; CHUNK_LEN],
    prev: &'a mut [f32; CHUNK_LEN],
    post: &'a [[f32; CHUNK_LEN]],
    posted: u64,
    graph: &'a Graph,
    tap: Option<&'a mut rtrb::Producer<f32>>,
    tap_device: u64,
    rate: f64,
    ramp: u32,
    eq_fade: u32,
    settle: bool,
}

/// How much of a device is heard once any fade is over.
#[inline]
fn wet_of(d: &Device) -> f32 {
    if d.active() {
        1.0
    } else {
        0.0
    }
}

/// The state index for device `id` on channel `st`, claiming a free one if
/// it has none; and whether it is new. `None` when every state is taken.
fn claim(st: &mut ChanState, devs: &mut [DevState], id: u64) -> Option<(usize, bool)> {
    if let Some(&(_, s)) = st.devs[..st.ndevs].iter().find(|(d, _)| *d == id) {
        return Some((s as usize, false));
    }
    if st.ndevs == st.devs.len() {
        return None;
    }
    let s = devs.iter().position(|d| d.device == NONE)?;
    devs[s].device = id;
    st.devs[st.ndevs] = (id, s as u16);
    st.ndevs += 1;
    Some((s, true))
}

/// Frees the device states of `st` that neither chain has.
fn sweep(st: &mut ChanState, devs: &mut [DevState], chains: Chains) {
    let keep = |id: u64| {
        chains.now.iter().any(|d| d.id == id)
            || chains.old.is_some_and(|c| c.iter().any(|d| d.id == id))
    };
    let mut i = 0;
    while i < st.ndevs {
        let (id, s) = st.devs[i];
        if keep(id) {
            i += 1;
        } else {
            devs[s as usize].device = NONE;
            st.devs[i] = st.devs[st.ndevs - 1];
            st.ndevs -= 1;
        }
    }
}

/// Frees every device state of `st`.
fn free_all(st: &mut ChanState, devs: &mut [DevState]) {
    for &(_, s) in &st.devs[..st.ndevs] {
        devs[s as usize].device = NONE;
    }
    st.ndevs = 0;
}

/// Resets the states of a chain's devices, as from silence.
fn reset_chain(st: &mut ChanState, devs: &mut [DevState], chain: &[Device]) {
    for d in chain.iter().take(MAX_DEVICES) {
        if let Some((s, _)) = claim(st, devs, d.id) {
            devs[s].reset(d, wet_of(d));
        }
    }
}

/// Whether running the chain would change anything: a device on, or one
/// still fading.
fn chain_live(st: &ChanState, devs: &[DevState], chains: Chains) -> bool {
    let fading = st.devs[..st.ndevs].iter().any(|&(_, s)| {
        let w = &devs[s as usize].wet;
        w.cur != 0.0 || w.moving()
    });
    fading
        || chains
            .now
            .iter()
            .take(MAX_DEVICES)
            .any(|d| wet_of(d) != 0.0)
        || chains
            .old
            .is_some_and(|c| c.iter().any(|d| !chains.now.iter().any(|x| x.id == d.id)))
}

/// Runs `buf` through a chain: the current devices in order and, while
/// crossfading from an older chain, its removed devices fading out where
/// they were.
fn run_chain(ctx: &mut Ctx, st: &mut ChanState, chains: Chains, shown: bool, buf: &mut [f32]) {
    let now = &chains.now[..chains.now.len().min(MAX_DEVICES)];
    let olds = chains.old.unwrap_or(&[]);
    let olds = &olds[..olds.len().min(MAX_DEVICES)];
    let mut j = 0;
    for i in 0..=now.len() {
        // Removed devices that sat at or before this position.
        while j < olds.len() && (j <= i || i == now.len()) {
            let d = &olds[j];
            j += 1;
            if !now.iter().any(|x| x.id == d.id) {
                run_device(ctx, st, d, 0.0, shown, false, buf);
            }
        }
        if let Some(d) = now.get(i) {
            let settle = ctx.settle;
            run_device(ctx, st, d, wet_of(d), shown, settle, buf);
        }
    }
}

/// Runs one device on `buf`, its wet share heading for `wet`.
fn run_device(
    ctx: &mut Ctx,
    st: &mut ChanState,
    d: &Device,
    wet: f32,
    shown: bool,
    settle: bool,
    buf: &mut [f32],
) {
    let Some((s, fresh)) = claim(st, ctx.devs, d.id) else {
        return;
    };
    let ds = &mut ctx.devs[s];
    let off = ds.wet.cur == 0.0 && !ds.wet.moving();
    if fresh || (off && wet != 0.0) {
        // New to the chain, or back from bypass: from silence, fading in
        // unless settling.
        ds.reset(d, if settle { wet } else { 0.0 });
    }
    if settle {
        ds.wet.jump(wet);
    } else {
        ds.wet.set(wet, ctx.ramp);
    }
    if ds.wet.cur != 0.0 || ds.wet.moving() {
        process_device(ctx, s, d, settle, buf);
    }
    if shown && d.id == ctx.tap_device {
        if let Some(sink) = ctx.tap.as_deref_mut() {
            for f in buf.as_chunks::<OUT_CHANNELS>().0 {
                // A full ring drops samples; the analyser only needs the
                // latest.
                let _ = sink.push(0.5 * (f[0] + f[1]));
            }
        }
    }
}

/// Runs device `d`, in state `s`, on `buf`.
fn process_device(ctx: &mut Ctx, s: usize, d: &Device, settle: bool, buf: &mut [f32]) {
    let ds = &mut ctx.devs[s];
    let len = buf.len();
    let fading = ds.wet.moving() || ds.wet.cur != 1.0;
    if fading {
        ctx.prev[..len].copy_from_slice(buf);
    }
    let ramp = if settle { 0 } else { ctx.ramp };
    match d.params() {
        DeviceParams::Eq { .. } => {
            ds.eq.process(
                d.eq_filters().sections(),
                ctx.eq_fade,
                buf,
                &mut ctx.alt[..],
            );
        }
        DeviceParams::Compressor(c) => {
            let key = match d.sidechain {
                None => None,
                // A silent or missing key channel: nothing to react to.
                Some(id) => Some(
                    ctx.graph
                        .slot(id)
                        .filter(|&src| ctx.posted & (1 << src) != 0)
                        .map_or(&ZEROS[..len], |src| &ctx.post[src][..len]),
                ),
            };
            let gr = ds.comp.process(c, ctx.rate, ramp, buf, key);
            ds.gr = ds.gr.min(gr);
        }
        DeviceParams::Utility(u) => ds.util.process(u, ctx.rate, ramp, buf),
    }
    if fading {
        let fs = buf.as_chunks_mut::<OUT_CHANNELS>().0;
        for (f, o) in fs.iter_mut().zip(ctx.prev.as_chunks::<OUT_CHANNELS>().0) {
            let w = ds.wet.next();
            f[0] = o[0] + (f[0] - o[0]) * w;
            f[1] = o[1] + (f[1] - o[1]) * w;
        }
    }
}

/// What one channel mixes this chunk.
struct ChanMix<'a> {
    /// Its slot.
    k: usize,
    /// Its volume, pan, sends and chain.
    track: &'a Track,
    /// The clips heard once any crossfade is over.
    clips: &'a [Clip],
    /// The clips being crossfaded from, while they sound different.
    old: Option<&'a [Clip]>,
    chains: Chains<'a>,
    /// Metered and tapped: false for a deleted channel fading out.
    shown: bool,
    /// Not muted or soloed out.
    heard: bool,
}

/// Plays a project from a position, one buffer at a time.
///
/// [`Renderer::process`] runs on the audio thread: it must never allocate,
/// lock or block. `tests/realtime.rs` enforces the allocation rule.
///
/// Each channel sums its clips and the sends into it, runs its chain, then
/// its volume and pan, and sends the result on. Channels render in an order
/// worked out from the sends and sidechains, so every channel's inputs are
/// ready before it runs; the master's chain and volume come last.
///
/// A new snapshot doesn't step the sound: changes to volume, pan, mute,
/// solo, sends, clip gain, device settings and the master volume ramp over
/// [`RAMP_SECONDS`], a changed EQ crossfades over [`EQ_FADE_SECONDS`],
/// devices fade in and out as they're added, removed or bypassed, and a
/// track whose clips sound different (moved, trimmed, stretched, faded,
/// enveloped, added, removed, or the track itself added or deleted)
/// crossfades from the old clips to the new ones over
/// [`EDIT_FADE_SECONDS`], before its devices so they run on without a
/// break. Values that hold still render exactly as without the ramps.
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
    /// Peak level per channel (by index) and side since the last
    /// [`Renderer::take_peaks`], after the channel's volume and pan.
    peaks: [[f32; 2]; METER_TRACKS],
    /// Mix state per channel slot, allocated up front.
    chans: Box<[ChanState]>,
    /// The master's.
    master_chan: Box<ChanState>,
    master: Ramp,
    devs: Box<[DevState]>,
    graph: Box<Graph>,
    /// The next block jumps straight to every value instead of ramping.
    settle: bool,
    /// Blocks rendered, to age clip ramps.
    blocks: u64,
    bufs: Bufs,
    /// Where one device's output goes, mono, for the analyser.
    tap: Option<rtrb::Producer<f32>>,
    /// The device tapped; [`NO_TAP`] for none.
    tap_device: u64,
}

/// Room for snapshots awaiting release: more than one block can finish.
const RELEASED: usize = 4;

/// Whether two versions of a track's clips sound the same, gains aside.
fn same_clips(a: &[Clip], b: &[Clip]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.same_sound(y))
}

/// A channel's chain and its old version's, while one crossfades to the
/// other.
#[derive(Clone, Copy)]
struct Chains<'a> {
    now: &'a [Device],
    old: Option<&'a [Device]>,
}

impl Renderer {
    pub fn new(project: Arc<Project>, pos: u64) -> Self {
        let mut r = Self {
            project,
            from: None,
            next: None,
            edit_left: 0,
            edit_whole: 1,
            released: std::array::from_fn(|_| None),
            pos,
            peaks: [[0.0; 2]; METER_TRACKS],
            chans: (0..METER_TRACKS).map(|_| ChanState::new()).collect(),
            master_chan: Box::new(ChanState::new()),
            master: Ramp::at(1.0),
            devs: (0..DEVICE_STATES).map(|_| DevState::new()).collect(),
            graph: Box::new(Graph::new()),
            settle: true,
            blocks: 0,
            bufs: Bufs {
                scratch: Box::new([0.0; CHUNK_LEN]),
                alt: Box::new([0.0; CHUNK_LEN]),
                prev: Box::new([0.0; CHUNK_LEN]),
                bus: vec![[0.0; CHUNK_LEN]; METER_TRACKS].into_boxed_slice(),
                post: vec![[0.0; CHUNK_LEN]; METER_TRACKS].into_boxed_slice(),
                fed: 0,
                posted: 0,
                done: 0,
            },
            tap: None,
            tap_device: NO_TAP,
        };
        r.arrange();
        r
    }

    /// Sends the tapped device's output to `sink` from now on.
    pub fn set_tap(&mut self, sink: rtrb::Producer<f32>) {
        self.tap = Some(sink);
    }

    /// Which device the tap listens to; [`NO_TAP`] for none. Real-time safe.
    pub fn tap_device(&mut self, device: u64) {
        self.tap_device = device;
    }

    /// Peak levels per channel since the last call, which resets them.
    /// Where a channel mixes straight into the master, its clips are
    /// metered one at a time, so where they overlap the meter shows the
    /// louder one, not the sum.
    pub fn take_peaks(&mut self) -> [[f32; 2]; METER_TRACKS] {
        std::mem::replace(&mut self.peaks, [[0.0; 2]; METER_TRACKS])
    }

    /// Calls `f` with each device state's index, its device's id and its
    /// most gain reduction (dB, 0 or above) since the last call, which
    /// resets them. Real-time safe.
    pub fn take_reduction(&mut self, mut f: impl FnMut(usize, u64, f32)) {
        for (i, d) in self.devs.iter_mut().enumerate() {
            if d.device != NONE {
                f(i, d.device, -d.gr);
                d.gr = 0.0;
            }
        }
    }

    /// Current timeline frame.
    pub fn position(&self) -> u64 {
        self.pos
    }

    /// Jumps to `pos`. Device tails from before the jump are dropped.
    pub fn seek(&mut self, pos: u64) {
        self.pos = pos;
        for d in self.devs.iter_mut() {
            *d.eq.z = [[[0.0; 2]; 2]; MAX_SECTIONS];
            d.eq.fade_left = 0;
            d.comp.gr = 0.0;
            d.util.dz = [[0.0; 2]; 2];
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

    /// Moves each channel's mix state to the slot of its index in the
    /// current snapshot, followed by channels deleted since `from`, so
    /// deleting or moving a channel doesn't restart the others' ramps and
    /// devices; frees the device states no chain uses any more; and works
    /// out the routing graph.
    fn arrange(&mut self) {
        let mut ids = [NONE; METER_TRACKS];
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
            if let Some(j) = (k..self.chans.len()).find(|&j| self.chans[j].track == ids[k]) {
                self.chans.swap(k, j);
                continue;
            }
            // No state for this channel: don't let it take one that a later
            // channel still needs.
            while let Some(m) =
                (k + 1..n).find(|&m| ids[m] == self.chans[k].track && self.chans[m].track != ids[m])
            {
                self.chans.swap(k, m);
            }
        }
        // Device states: keep those a chain (now, or being faded from)
        // still has; free the rest.
        let project = &self.project;
        let from = self.from.as_deref();
        for (k, st) in self.chans.iter_mut().enumerate() {
            if k >= n || st.track != ids[k] {
                free_all(st, &mut self.devs);
                if k >= n {
                    st.track = NONE;
                }
                continue;
            }
            let id = st.track;
            let now = project.tracks.iter().find(|t| t.id == id);
            let was = from.and_then(|p| p.tracks.iter().find(|t| t.id == id));
            let chains = Chains {
                now: now.map_or(&[][..], |t| &t.chain[..]),
                old: was.map(|t| &t.chain[..]),
            };
            sweep(st, &mut self.devs, chains);
        }
        let chains = Chains {
            now: &project.master_chain,
            old: from.map(|p| &p.master_chain[..]),
        };
        sweep(&mut self.master_chan, &mut self.devs, chains);
        self.graph.ids[..n].copy_from_slice(ids);
        self.graph.n = n;
        self.graph.build(project, from);
    }

    /// Fills `out` (interleaved stereo) with the next frames and advances.
    pub fn process(&mut self, out: &mut [f32]) {
        debug_assert_eq!(out.len() % OUT_CHANNELS, 0);
        out.fill(0.0);
        let mut settle = std::mem::take(&mut self.settle);
        if settle && self.from.is_some() {
            self.end_edit();
        }
        self.blocks += 1;
        for chunk in out.chunks_mut(CHUNK_LEN) {
            self.chunk(chunk, settle);
            settle = false;
        }
    }

    /// Renders up to [`CHUNK`] frames into `out`, which is silent.
    fn chunk(&mut self, out: &mut [f32], settle: bool) {
        let frames = (out.len() / OUT_CHANNELS) as u64;
        let (from, to) = (self.pos, self.pos + frames);
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
        self.bufs.fed = 0;
        self.bufs.done = 0;
        self.bufs.posted = 0;
        for i in 0..self.graph.n {
            let k = self.graph.order[i] as usize;
            let id = self.graph.ids[k];
            let now = project.tracks.get(k).filter(|t| t.id == id);
            let was = old
                .as_ref()
                .and_then(|p| p.tracks.iter().find(|t| t.id == id));
            let (track, clips, old_clips, shown) = match (now, was) {
                (Some(t), None) if old.is_none() => (t, &t.clips[..], None, true),
                (Some(t), Some(w)) if same_clips(&w.clips, &t.clips) => {
                    (t, &t.clips[..], None, true)
                }
                (Some(t), Some(w)) => (t, &t.clips[..], Some(&w.clips[..]), true),
                // A new track fades in.
                (Some(t), None) => (t, &t.clips[..], Some(&[][..]), true),
                // A deleted one fades out, through its devices and at its
                // volume.
                (None, Some(w)) => (w, &[][..], Some(&w.clips[..]), false),
                (None, None) => continue,
            };
            let chains = Chains {
                now: &track.chain,
                old: was.filter(|_| shown).map(|w| &w.chain[..]),
            };
            let heard = if shown {
                self.graph.heard[k]
            } else {
                !track.muted
            };
            let mix = ChanMix {
                k,
                track,
                clips,
                old: old_clips,
                chains,
                shown,
                heard,
            };
            self.mix_channel(mix, settle, ramp, from, to, out);
        }
        // Past the metered channels: straight into the master, no devices
        // and no smoothing.
        for track in project.tracks.iter().skip(METER_TRACKS) {
            if !track.sends.is_empty() && project.audible(track) {
                let (gl, gr) = track.side_gains();
                for clip in &track.clips {
                    mix_clip(clip, from, to, out, gl, gr, None);
                }
            }
        }
        // The master's chain, then its volume.
        let chains = Chains {
            now: &project.master_chain,
            old: old.as_ref().map(|p| &p.master_chain[..]),
        };
        if settle {
            reset_chain(&mut self.master_chan, &mut self.devs, chains.now);
        }
        let tapped = self.tap.is_some() && chains.now.iter().any(|d| d.id == self.tap_device);
        if tapped || chain_live(&self.master_chan, &self.devs, chains) {
            let Renderer {
                devs,
                graph,
                bufs,
                tap,
                tap_device,
                master_chan,
                ..
            } = self;
            let mut ctx = Ctx {
                devs,
                alt: &mut bufs.alt,
                prev: &mut bufs.prev,
                post: &bufs.post,
                posted: bufs.posted,
                graph,
                tap: tap.as_mut(),
                tap_device: *tap_device,
                rate,
                ramp,
                eq_fade: (EQ_FADE_SECONDS * rate).round().max(1.0) as u32,
                settle,
            };
            run_chain(&mut ctx, master_chan, chains, true, out);
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
                } else {
                    self.arrange();
                }
            }
        }
    }

    /// Mixes one channel's frames `from..to` into the master (`out`) or the
    /// channels it sends to.
    fn mix_channel(
        &mut self,
        mix: ChanMix,
        settle: bool,
        ramp: u32,
        from: u64,
        to: u64,
        out: &mut [f32],
    ) {
        let ChanMix {
            k,
            track,
            clips,
            old,
            chains,
            shown,
            heard,
        } = mix;
        let block = self.blocks;
        let rate = self.project.sample_rate as f64;
        let (edit_left, edit_whole) = (self.edit_left as u64, self.edit_whole as f32);
        let Renderer {
            chans,
            devs,
            graph,
            bufs,
            tap,
            tap_device,
            peaks,
            ..
        } = self;
        bufs.done |= 1 << k;
        let st = &mut chans[k];
        let target = if heard {
            track.side_gains()
        } else {
            (0.0, 0.0)
        };
        if settle || st.track != track.id {
            if st.track != track.id {
                free_all(st, devs);
            }
            st.reset(track, target);
            reset_chain(st, devs, chains.now);
        } else {
            st.gain[0].set(target.0, ramp);
            st.gain[1].set(target.1, ramp);
            st.follow_sends(track, ramp);
        }
        let ramping = st.gain[0].moving() || st.gain[1].moving();
        if !heard && !ramping {
            st.idle = true;
            return;
        }
        if st.idle {
            // Back from silence, fading in from 0: no old state to fade
            // from.
            st.idle = false;
            reset_chain(st, devs, chains.now);
        }
        let fed = bufs.fed & (1 << k) != 0;
        let keyed = graph.keyed & (1 << k) != 0;
        let tapped = shown && tap.is_some() && chains.now.iter().any(|d| d.id == *tap_device);
        let live = chain_live(st, devs, chains) || tapped;
        let (mut pl, mut pr) = (0.0f32, 0.0f32);
        if !(live || ramping || old.is_some() || fed || keyed || !st.plain_send()) {
            // Straight into the master, as a track with nothing on it.
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
            if shown {
                let p = &mut peaks[k];
                p[0] = p[0].max(pl);
                p[1] = p[1].max(pr);
            }
            return;
        }
        let len = (to - from) as usize * OUT_CHANNELS;
        let buf = &mut bufs.scratch[..len];
        buf.fill(0.0);
        for clip in clips {
            if clip.start >= to || clip.end() <= from {
                continue;
            }
            let g = st.clip_gain(clip, block, ramp);
            mix_clip(clip, from, to, buf, 1.0, 1.0, Some(g));
        }
        if let Some(old) = old {
            // From the old clips to the new, in a straight line.
            let prev = &mut bufs.prev[..len];
            prev.fill(0.0);
            for clip in old {
                mix_clip(clip, from, to, prev, 1.0, 1.0, None);
            }
            let fs = buf.as_chunks_mut::<OUT_CHANNELS>().0;
            let done = from + edit_left;
            for (t, (f, o)) in (from..to).zip(fs.iter_mut().zip(prev.as_chunks::<OUT_CHANNELS>().0))
            {
                if t >= done {
                    break;
                }
                let w = 1.0 - (done - t) as f32 / edit_whole;
                f[0] = o[0] + (f[0] - o[0]) * w;
                f[1] = o[1] + (f[1] - o[1]) * w;
            }
        }
        if fed {
            for (x, b) in buf.iter_mut().zip(&bufs.bus[k][..len]) {
                *x += b;
            }
        }
        if live {
            let mut ctx = Ctx {
                devs,
                alt: &mut bufs.alt,
                prev: &mut bufs.prev,
                post: &bufs.post,
                posted: bufs.posted,
                graph,
                tap: tap.as_mut(),
                tap_device: *tap_device,
                rate,
                ramp,
                eq_fade: (EQ_FADE_SECONDS * rate).round().max(1.0) as u32,
                settle,
            };
            run_chain(&mut ctx, st, chains, shown, buf);
        }
        // Volume and pan.
        let post = &mut bufs.post[k][..len];
        let fs = buf.as_chunks::<OUT_CHANNELS>().0;
        for (f, p) in fs.iter().zip(post.as_chunks_mut::<OUT_CHANNELS>().0) {
            let (gl, gr) = (st.gain[0].next(), st.gain[1].next());
            let (l, r) = (f[0] * gl, f[1] * gr);
            p[0] = l;
            p[1] = r;
            pl = pl.max(l.abs());
            pr = pr.max(r.abs());
        }
        bufs.posted |= 1 << k;
        if !heard && !(st.gain[0].moving() || st.gain[1].moving()) {
            st.idle = true;
        }
        if shown {
            let p = &mut peaks[k];
            p[0] = p[0].max(pl);
            p[1] = p[1].max(pr);
        }
        // The sends, each at its own level.
        let post = &bufs.post[k][..len];
        for (to_id, g) in st.sends[..st.nsends].iter_mut() {
            let dst: &mut [f32] = if *to_id == MASTER {
                &mut out[..len]
            } else {
                match graph.slot(*to_id) {
                    // A channel already rendered (a loop being broken
                    // mid-crossfade) misses this chunk.
                    Some(d) if bufs.done & (1 << d) == 0 => {
                        if bufs.fed & (1 << d) == 0 {
                            bufs.fed |= 1 << d;
                            bufs.bus[d][..len].fill(0.0);
                        }
                        &mut bufs.bus[d][..len]
                    }
                    _ => {
                        for _ in 0..len / OUT_CHANNELS {
                            g.next();
                        }
                        continue;
                    }
                }
            };
            if g.moving() {
                let ps = post.as_chunks::<OUT_CHANNELS>().0;
                for (d, p) in dst.as_chunks_mut::<OUT_CHANNELS>().0.iter_mut().zip(ps) {
                    let v = g.next();
                    d[0] += p[0] * v;
                    d[1] += p[1] * v;
                }
            } else if g.cur == 1.0 {
                for (d, p) in dst.iter_mut().zip(post) {
                    *d += p;
                }
            } else if g.cur != 0.0 {
                let v = g.cur;
                for (d, p) in dst.iter_mut().zip(post) {
                    *d += p * v;
                }
            }
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
    use crate::device::Device;
    use crate::eq::{BandKind, EqBand};
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
        b.tracks[0].chain = vec![Device::eq(9, &[band], RATE)];
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
        kept.tracks[0].chain = vec![Device::eq(9, &[band], RATE)];
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

    /// Track 1 (a steady 0.5) and, when `bus`, a mixer-only channel 2 it
    /// sends to instead of the master.
    fn routed(bus: bool) -> Project {
        let mut p = project(false);
        p.tracks[0].id = 1;
        if bus {
            p.tracks[0].sends = vec![crate::model::Send { to: 2, gain: 0.5 }];
            p.tracks.push(Track {
                id: 2,
                lane: false,
                ..Track::default()
            });
        }
        p
    }

    #[test]
    fn sends_go_through_buses_after_the_volume() {
        let mut p = routed(true);
        p.tracks[0].gain = 0.5;
        let out = render(Arc::new(p.clone()), 0, 512);
        // 0.5 × volume 0.5 × send 0.5.
        assert!(side(&out, 0).iter().all(|&x| (x - 0.125).abs() < 1e-6));
        // The bus's own volume and devices apply on top.
        p.tracks[1].chain = vec![Device::new(
            5,
            crate::device::DeviceParams::Utility(crate::device::UtilityParams {
                gain_db: -96.0,
                ..Default::default()
            }),
            RATE,
        )];
        let out = render(Arc::new(p.clone()), 0, 512);
        assert!(out.iter().all(|&x| x == 0.0));
        // No sends: silent.
        p.tracks[0].sends.clear();
        p.tracks[1].chain.clear();
        assert!(render(Arc::new(p), 0, 512).iter().all(|&x| x == 0.0));
    }

    #[test]
    fn soloing_a_bus_plays_what_feeds_it() {
        let mut p = routed(true);
        p.tracks[1].solo = true;
        let out = render(Arc::new(p.clone()), 0, 256);
        assert!((out[0] - 0.25).abs() < 1e-6);
        // Soloing something else silences both.
        p.tracks[1].solo = false;
        p.tracks.push(Track {
            id: 3,
            solo: true,
            ..Track::default()
        });
        assert!(render(Arc::new(p), 0, 256).iter().all(|&x| x == 0.0));
    }

    #[test]
    fn a_sidechained_compressor_ducks_to_its_key() {
        use crate::device::{CompParams, DeviceParams};
        // Track 1 is the key (loud), track 4 the pad being ducked.
        let mut p = routed(false);
        let mut pad = p.tracks[0].clone();
        pad.id = 4;
        let mut comp = Device::new(
            9,
            DeviceParams::Compressor(CompParams {
                threshold_db: -20.0,
                ratio: 20.0,
                attack_ms: 0.1,
                knee_db: 0.0,
                ..CompParams::default()
            }),
            RATE,
        );
        comp.sidechain = Some(1);
        pad.chain = vec![comp];
        p.tracks[0].sends.clear();
        p.tracks.push(pad);
        let out = side(&render(Arc::new(p.clone()), 0, 4800), 0);
        // The key at -6 dBFS is 14 dB over: about 13.3 dB of reduction.
        let want = 0.5 * 10f32.powf(-14.0 * (1.0 - 1.0 / 20.0) / 20.0);
        assert!((out[4000] - want).abs() < 0.01, "{} vs {want}", out[4000]);
        // With the key muted, nothing to react to.
        p.tracks[0].muted = true;
        let out = side(&render(Arc::new(p), 0, 4800), 0);
        assert!((out[4000] - 0.5).abs() < 1e-4);
    }

    #[test]
    fn bypassing_and_routing_changes_ramp() {
        use crate::device::{DeviceParams, UtilityParams};
        let gain = |db| {
            Device::new(
                5,
                DeviceParams::Utility(UtilityParams {
                    gain_db: db,
                    ..Default::default()
                }),
                RATE,
            )
        };
        let mut a = routed(true);
        a.tracks[1].chain = vec![gain(-96.0)];
        let mut b = a.clone();
        b.tracks[1].chain[0].on = false;
        // Bypassing the silencing device fades the bus in.
        let left = side(&change(a.clone(), b.clone(), 2048), 0);
        assert!(max_step(&left, 0.0) <= 0.25 / RAMP as f32 * 1.01);
        assert!((left[RAMP + 1] - 0.25).abs() < 1e-6);
        // Rerouting from the bus to the master crossfades the sends.
        let mut c = routed(true);
        c.tracks[0].sends = vec![crate::model::Send::master()];
        let left = side(&change(routed(true), c, 2048), 0);
        assert!(max_step(&left, 0.25) <= 0.5 / RAMP as f32 * 1.01);
        assert!((left[RAMP + 1] - 0.5).abs() < 1e-6);
        // Removing a device fades it out.
        let mut d = a.clone();
        d.tracks[1].chain.clear();
        let left = side(&change(a, d, 2048), 0);
        assert!(max_step(&left, 0.0) <= 0.25 / RAMP as f32 * 1.01);
    }

    #[test]
    fn a_loop_between_two_snapshots_still_renders() {
        // 1 → 2 becomes 2 → 1 mid-crossfade: no hang, no panic, and it
        // settles on the new routing.
        let a = routed(true);
        let mut b = a.clone();
        b.tracks[0].sends = vec![crate::model::Send::master()];
        b.tracks[1].sends = vec![crate::model::Send { to: 1, gain: 1.0 }];
        let out = side(&change(a, b, 4096), 0);
        assert!((out[4000] - 0.5).abs() < 1e-6);
    }
}
