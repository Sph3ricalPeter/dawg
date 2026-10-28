use std::sync::Arc;

/// Decoded audio, interleaved `f32`, at the project sample rate.
///
/// Sources are shared between clips and never change once decoded, so the
/// audio thread can read them without locks.
#[derive(Debug)]
pub struct Source {
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
        Self { channels, samples }
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

/// A window onto a source, placed on a track's timeline.
#[derive(Debug, Clone)]
pub struct Clip {
    pub source: Arc<Source>,
    /// Timeline position of the clip's first frame.
    pub start: u64,
    /// First source frame that plays (the trimmed-off head).
    pub offset: u64,
    /// Number of frames that play.
    pub len: u64,
    /// Linear gain.
    pub gain: f32,
    /// Linear fade from silence over the first `fade_in` frames.
    pub fade_in: u64,
    /// Linear fade to silence over the last `fade_out` frames.
    pub fade_out: u64,
}

impl Clip {
    /// The whole source at `start`, unity gain.
    pub fn new(source: Arc<Source>, start: u64) -> Self {
        let len = source.frames();
        Self {
            source,
            start,
            offset: 0,
            len,
            gain: 1.0,
            fade_in: 0,
            fade_out: 0,
        }
    }

    pub fn end(&self) -> u64 {
        self.start + self.len
    }

    /// Fade multiplier at frame `i` of the clip (0 is the first frame that
    /// plays). Exactly 1.0 outside the fades, so untouched frames stay
    /// bit-identical on export.
    #[inline]
    pub fn fade_at(&self, i: u64) -> f64 {
        let mut f = 1.0;
        if i < self.fade_in {
            f *= i as f64 / self.fade_in as f64;
        }
        let tail = self.len.saturating_sub(self.fade_out);
        if self.fade_out > 0 && i >= tail {
            f *= self.len.saturating_sub(i + 1) as f64 / self.fade_out as f64;
        }
        f
    }

    /// Total multiplier (clip gain times fades) at frame `i` of the clip. The
    /// renderer and the WAV export both use it.
    #[inline]
    pub fn gain_at(&self, i: u64) -> f64 {
        self.gain as f64 * self.fade_at(i)
    }

    /// True when the clip plays the source's frames unchanged.
    pub fn is_unity(&self) -> bool {
        self.gain == 1.0 && self.fade_in == 0 && self.fade_out == 0
    }

    /// Same edit state: source, position, trim, gain and fades.
    pub fn same_edit(&self, other: &Clip) -> bool {
        Arc::ptr_eq(&self.source, &other.source)
            && self.start == other.start
            && self.offset == other.offset
            && self.len == other.len
            && self.gain == other.gain
            && self.fade_in == other.fade_in
            && self.fade_out == other.fade_out
    }
}

#[derive(Debug, Clone)]
pub struct Track {
    pub clips: Vec<Clip>,
    /// Linear gain.
    pub gain: f32,
    pub muted: bool,
}

impl Default for Track {
    fn default() -> Self {
        Self {
            clips: Vec::new(),
            gain: 1.0,
            muted: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Project {
    pub sample_rate: u32,
    pub tracks: Vec<Track>,
}

impl Project {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            tracks: Vec::new(),
        }
    }

    /// Same edit state as `other`, clip by clip.
    pub fn same_edit(&self, other: &Project) -> bool {
        self.sample_rate == other.sample_rate
            && self.tracks.len() == other.tracks.len()
            && self.tracks.iter().zip(&other.tracks).all(|(a, b)| {
                a.gain == b.gain
                    && a.muted == b.muted
                    && a.clips.len() == b.clips.len()
                    && a.clips.iter().zip(&b.clips).all(|(x, y)| x.same_edit(y))
            })
    }

    /// Timeline frame of the first clip, or 0 when there are none.
    pub fn start(&self) -> u64 {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter().map(|c| c.start))
            .min()
            .unwrap_or(0)
    }

    /// Timeline frame just past the last clip.
    pub fn end(&self) -> u64 {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter().map(Clip::end))
            .max()
            .unwrap_or(0)
    }
}
