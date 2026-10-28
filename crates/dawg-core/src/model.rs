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
    /// `samples` is interleaved; only mono and stereo are supported for now.
    pub fn new(channels: u16, samples: impl Into<Arc<[f32]>>) -> Self {
        assert!(
            channels == 1 || channels == 2,
            "only mono and stereo sources are supported, got {channels} channels"
        );
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
        }
    }

    pub fn end(&self) -> u64 {
        self.start + self.len
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

    /// Timeline frame just past the last clip.
    pub fn end(&self) -> u64 {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter().map(Clip::end))
            .max()
            .unwrap_or(0)
    }
}
