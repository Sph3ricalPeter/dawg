use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::eq::Eq;
use crate::stretch;

/// Decoded audio, interleaved `f32`, at the project sample rate.
///
/// Sources are shared between clips and never change once decoded, so the
/// audio thread can read them without locks.
/// Cloning shares the samples.
#[derive(Debug, Clone)]
pub struct Source {
    id: u64,
    channels: u16,
    samples: Arc<[f32]>,
}

impl Source {
    /// `samples` is interleaved. Sources with more than two channels play
    /// their first two; export keeps every channel (see [`crate::wav`]).
    pub fn new(channels: u16, samples: impl Into<Arc<[f32]>>) -> Self {
        assert!(channels >= 1, "a source needs at least one channel");
        let samples = samples.into();
        assert!(
            samples.len() % channels as usize == 0,
            "sample count {} is not a multiple of {channels} channels",
            samples.len()
        );
        Self {
            id: 0,
            channels,
            samples,
        }
    }

    /// The same audio under the id a project knows it by.
    pub fn with_id(self, id: u64) -> Self {
        Self { id, ..self }
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn frames(&self) -> u64 {
        (self.samples.len() / self.channels as usize) as u64
    }

    /// Interleaved samples.
    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    /// The same audio back to front, under the same id.
    pub fn reversed(&self) -> Source {
        let ch = self.channels as usize;
        let mut out = Vec::with_capacity(self.samples.len());
        for f in self.samples.chunks_exact(ch).rev() {
            out.extend_from_slice(f);
        }
        Source::new(self.channels, out).with_id(self.id)
    }

    /// Left and right sample at `frame`; mono is copied to both sides.
    #[inline]
    pub(crate) fn frame(&self, frame: u64) -> (f32, f32) {
        let i = frame as usize * self.channels as usize;
        if self.channels == 1 {
            let s = self.samples[i];
            (s, s)
        } else {
            (self.samples[i], self.samples[i + 1])
        }
    }
}

/// One point of a clip's volume envelope.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct EnvPoint {
    /// Source frame the point sits on, so trimming a clip never slides its
    /// envelope against the audio.
    pub at: u64,
    /// Linear gain, 0 to [`ENV_MAX`].
    pub gain: f32,
}

/// Top of the envelope range: about +1.9 dB, so 0 dB sits at 80% height.
pub const ENV_MAX: f32 = 1.25;

/// Shape of a fade, from silence to full level.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FadeCurve {
    /// A straight line.
    #[default]
    Linear,
    /// Slow near silence, quick near full level: `t²`.
    Exp,
    /// Eases in and out: smoothstep.
    S,
}

impl FadeCurve {
    /// Level at `t` (0 is silence, 1 full) along the fade.
    #[inline]
    pub fn shape(self, t: f64) -> f64 {
        match self {
            FadeCurve::Linear => t,
            FadeCurve::Exp => t * t,
            FadeCurve::S => t * t * (3.0 - 2.0 * t),
        }
    }
}

/// A window onto a source, placed on a track's timeline.
#[derive(Debug, Clone)]
pub struct Clip {
    /// Stable id, unique in the project.
    pub id: u64,
    pub source: Arc<Source>,
    /// Timeline position of the clip's first frame.
    pub start: u64,
    /// First source frame that plays (the trimmed-off head).
    pub offset: u64,
    /// Number of timeline frames that play. With a stretch they cover
    /// `len / stretch` source frames.
    pub len: u64,
    /// Linear gain.
    pub gain: f32,
    /// Fade from silence over the first `fade_in` frames.
    pub fade_in: u64,
    /// Fade to silence over the last `fade_out` frames.
    pub fade_out: u64,
    pub fade_in_curve: FadeCurve,
    pub fade_out_curve: FadeCurve,
    /// Plays the source backwards. `offset` and envelope points are then
    /// frames of the reversed source, so trims and envelopes work as on any
    /// other clip; [`Clip::audio`] holds the reversed audio.
    pub reversed: bool,
    /// Volume envelope, sorted by `at`. Empty is flat at unity; between
    /// points the gain is a straight line, and it holds the first and last
    /// values outside them.
    pub envelope: Arc<[EnvPoint]>,
    /// Timeline frames per source frame: 2.0 plays the audio twice as long,
    /// at the same pitch.
    pub stretch: f64,
    /// Pitch shift in semitones, keeping the length.
    pub pitch: f32,
    /// The whole source stretched and pitched, when either is set; frame `j`
    /// is source position `j / stretch`. Made by [`Clip::retime`].
    pub audio: Option<Arc<Source>>,
}

impl Clip {
    /// The whole source at `start`, unity gain.
    pub fn new(source: Arc<Source>, start: u64) -> Self {
        let len = source.frames();
        Self {
            id: 0,
            source,
            start,
            offset: 0,
            len,
            gain: 1.0,
            fade_in: 0,
            fade_out: 0,
            fade_in_curve: FadeCurve::Linear,
            fade_out_curve: FadeCurve::Linear,
            reversed: false,
            envelope: Arc::new([]),
            stretch: 1.0,
            pitch: 0.0,
            audio: None,
        }
    }

    pub fn end(&self) -> u64 {
        self.start + self.len
    }

    /// Stretched, pitched or reversed: the clip plays [`Clip::audio`].
    pub fn retimed(&self) -> bool {
        self.stretch != 1.0 || self.pitch != 0.0 || self.reversed
    }

    /// Remakes [`Clip::audio`] for the current stretch and pitch, unless
    /// `like` (another clip of the same source) already has it.
    pub fn retime(&mut self, rate: u32, like: Option<&Clip>) {
        if !self.retimed() {
            self.audio = None;
            return;
        }
        if let Some(a) = like.filter(|c| {
            Arc::ptr_eq(&c.source, &self.source)
                && c.stretch == self.stretch
                && c.pitch == self.pitch
                && c.reversed == self.reversed
        }) {
            if let Some(audio) = &a.audio {
                self.audio = Some(audio.clone());
                return;
            }
        }
        let reversed;
        let src: &Source = if self.reversed {
            reversed = self.source.reversed();
            &reversed
        } else {
            &self.source
        };
        self.audio = Some(Arc::new(if self.stretch == 1.0 && self.pitch == 0.0 {
            src.clone()
        } else {
            stretch::process(src, rate, self.stretch, self.pitch)
        }));
    }

    /// Source frames the clip covers from `offset` on.
    pub fn covered(&self) -> u64 {
        let n = if self.stretch == 1.0 {
            self.len
        } else {
            (self.len as f64 / self.stretch).ceil() as u64
        };
        n.min(self.source.frames().saturating_sub(self.offset))
    }

    /// Turns the clip around: the same stretch of audio, played the other
    /// way, with its envelope mirrored onto it. Call [`Clip::retime`] after.
    pub fn reverse(&mut self) {
        let frames = self.source.frames();
        self.offset = frames.saturating_sub(self.offset + self.covered());
        let last = frames.saturating_sub(1);
        let env: Vec<EnvPoint> = self
            .envelope
            .iter()
            .rev()
            .map(|p| EnvPoint {
                at: last - p.at.min(last),
                gain: p.gain,
            })
            .collect();
        self.envelope = env.into();
        self.reversed = !self.reversed;
    }

    /// Source position of frame `i` of the clip.
    #[inline]
    pub fn source_at(&self, i: u64) -> u64 {
        if self.stretch == 1.0 {
            self.offset + i
        } else {
            self.offset + (i as f64 / self.stretch) as u64
        }
    }

    /// Longest the clip can be from source frame `offset` on, in timeline
    /// frames.
    pub fn max_len(&self, offset: u64) -> u64 {
        let rest = self.source.frames().saturating_sub(offset);
        if self.stretch == 1.0 {
            rest
        } else {
            (rest as f64 * self.stretch).floor() as u64
        }
    }

    /// Left and right sample at frame `i` of the clip, before gain.
    #[inline]
    pub(crate) fn frame(&self, i: u64) -> (f32, f32) {
        match &self.audio {
            Some(a) => {
                let at = (self.offset as f64 * self.stretch).round() as u64 + i;
                a.frame(at.min(a.frames().saturating_sub(1)))
            }
            None => self.source.frame(self.offset + i),
        }
    }

    /// Fade multiplier at frame `i` of the clip (0 is the first frame that
    /// plays). Exactly 1.0 outside the fades, so untouched frames stay
    /// bit-identical on export.
    #[inline]
    pub fn fade_at(&self, i: u64) -> f64 {
        let mut f = 1.0;
        if i < self.fade_in {
            f *= self.fade_in_curve.shape(i as f64 / self.fade_in as f64);
        }
        let tail = self.len.saturating_sub(self.fade_out);
        if self.fade_out > 0 && i >= tail {
            f *= self
                .fade_out_curve
                .shape(self.len.saturating_sub(i + 1) as f64 / self.fade_out as f64);
        }
        f
    }

    /// Envelope gain at source frame `at`. Real-time safe.
    #[inline]
    pub fn envelope_at(&self, at: u64) -> f64 {
        let env = &self.envelope[..];
        let (first, last) = match (env.first(), env.last()) {
            (Some(f), Some(l)) => (f, l),
            _ => return 1.0,
        };
        if at <= first.at {
            return first.gain as f64;
        }
        if at >= last.at {
            return last.gain as f64;
        }
        // First point past `at`; there is one before it.
        let k = env.partition_point(|p| p.at <= at);
        let (a, b) = (&env[k - 1], &env[k]);
        let t = (at - a.at) as f64 / (b.at - a.at) as f64;
        a.gain as f64 + (b.gain as f64 - a.gain as f64) * t
    }

    /// Total multiplier (clip gain, fades and envelope) at frame `i` of the
    /// clip. The renderer and the WAV export both use it.
    #[inline]
    pub fn gain_at(&self, i: u64) -> f64 {
        self.gain as f64 * self.fade_at(i) * self.envelope_at(self.source_at(i))
    }

    /// True when the clip plays the source's frames unchanged.
    pub fn is_unity(&self) -> bool {
        self.gain == 1.0
            && self.fade_in == 0
            && self.fade_out == 0
            && self.envelope.iter().all(|p| p.gain == 1.0)
    }

    /// Same edit state: source, position, trim, gain, fades and envelope.
    pub fn same_edit(&self, other: &Clip) -> bool {
        self.id == other.id
            && Arc::ptr_eq(&self.source, &other.source)
            && self.start == other.start
            && self.offset == other.offset
            && self.len == other.len
            && self.gain == other.gain
            && self.fade_in == other.fade_in
            && self.fade_out == other.fade_out
            && self.fade_in_curve == other.fade_in_curve
            && self.fade_out_curve == other.fade_out_curve
            && self.reversed == other.reversed
            && self.envelope == other.envelope
            && self.stretch == other.stretch
            && self.pitch == other.pitch
    }
}

#[derive(Debug, Clone)]
pub struct Track {
    /// Stable id, unique in the project.
    pub id: u64,
    pub name: String,
    pub clips: Vec<Clip>,
    /// Linear gain.
    pub gain: f32,
    /// -1 (left) to 1 (right). A balance control: the centre leaves both
    /// sides untouched.
    pub pan: f32,
    pub muted: bool,
    pub solo: bool,
    /// Runs on the clips' sum, before volume and pan.
    pub eq: Eq,
}

impl Default for Track {
    fn default() -> Self {
        Self {
            id: 0,
            name: String::new(),
            clips: Vec::new(),
            gain: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            eq: Eq::default(),
        }
    }
}

impl Track {
    /// Left and right gain from the track's volume and pan.
    #[inline]
    pub fn side_gains(&self) -> (f32, f32) {
        let p = self.pan.clamp(-1.0, 1.0);
        (
            self.gain * (1.0 - p).min(1.0),
            self.gain * (1.0 + p).min(1.0),
        )
    }

    fn same_edit(&self, b: &Track) -> bool {
        self.id == b.id
            && self.name == b.name
            && self.gain == b.gain
            && self.pan == b.pan
            && self.muted == b.muted
            && self.solo == b.solo
            && self.eq.bands() == b.eq.bands()
            && self.eq.bypass() == b.eq.bypass()
            && self.clips.len() == b.clips.len()
            && self.clips.iter().zip(&b.clips).all(|(x, y)| x.same_edit(y))
    }
}

#[derive(Debug, Clone)]
pub struct Project {
    pub sample_rate: u32,
    pub tracks: Vec<Track>,
    /// Audio the project's clips can use, by [`Source::id`].
    pub sources: Vec<Arc<Source>>,
    /// The next id to hand out to a track, clip or source.
    pub next_id: u64,
    /// Master volume, linear, on the sum of every track.
    pub master_gain: f32,
}

impl Project {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            tracks: Vec::new(),
            sources: Vec::new(),
            next_id: 1,
            master_gain: 1.0,
        }
    }

    /// A project of `tracks` as they are, ids and all.
    pub fn with_tracks(sample_rate: u32, tracks: Vec<Track>) -> Self {
        Self {
            tracks,
            ..Self::new(sample_rate)
        }
    }

    /// Hands out a fresh id.
    pub fn new_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn source(&self, id: u64) -> Option<&Arc<Source>> {
        self.sources.iter().find(|s| s.id() == id)
    }

    pub fn track(&self, id: u64) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    /// The clip with `id` and the index of its track.
    pub fn clip(&self, id: u64) -> Option<(usize, &Clip)> {
        self.tracks
            .iter()
            .enumerate()
            .find_map(|(t, track)| track.clips.iter().find(|c| c.id == id).map(|c| (t, c)))
    }

    /// Every clip, with its track.
    pub fn clips(&self) -> impl Iterator<Item = (&Track, &Clip)> {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter().map(move |c| (t, c)))
    }

    /// Whether a track is heard: not muted, and soloed if anything is.
    pub fn audible(&self, track: &Track) -> bool {
        !track.muted && (track.solo || !self.tracks.iter().any(|t| t.solo))
    }

    /// Same edit state as `other`, clip by clip.
    pub fn same_edit(&self, other: &Project) -> bool {
        self.sample_rate == other.sample_rate
            && self.master_gain == other.master_gain
            && self.tracks.len() == other.tracks.len()
            && self
                .tracks
                .iter()
                .zip(&other.tracks)
                .all(|(a, b)| a.same_edit(b))
    }

    /// Timeline frames from the first clip heard to the end of the last: what
    /// a mixdown covers. `None` when nothing is heard.
    pub fn audible_span(&self) -> Option<(u64, u64)> {
        let heard = self.clips().filter(|(t, _)| self.audible(t));
        let (mut lo, mut hi) = (u64::MAX, 0);
        for (_, c) in heard {
            lo = lo.min(c.start);
            hi = hi.max(c.end());
        }
        (hi > lo).then_some((lo, hi))
    }

    /// Timeline frame of the first clip, or 0 when there are none.
    pub fn start(&self) -> u64 {
        self.clips().map(|(_, c)| c.start).min().unwrap_or(0)
    }

    /// Timeline frame just past the last clip.
    pub fn end(&self) -> u64 {
        self.clips().map(|(_, c)| c.end()).max().unwrap_or(0)
    }
}
