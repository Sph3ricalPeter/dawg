//! An audio file dawg can open and save: WAV or MP3.
//!
//! Saving in the file's own format follows that codec's rules ([`crate::wav`]
//! keeps the format and untouched bytes, [`crate::mp3`] keeps the rate,
//! bitrate and tags). Exporting to the other format writes a plain file:
//! 24-bit PCM WAV from an MP3, or a 320 kbps MP3 from a WAV.

use std::fmt;
use std::path::Path;

use serde::Serialize;

use crate::model::Clip;
use crate::mp3::{self, Mp3Error, Mp3File, Tags};
use crate::wav::{encode_simple, WavError, WavFile, WavFormat};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    Wav,
    Mp3,
}

impl Codec {
    /// The codec a file name asks for, by its extension.
    pub fn for_path(path: &Path) -> Option<Codec> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "wav" | "wave" => Some(Codec::Wav),
            "mp3" => Some(Codec::Mp3),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileError {
    Wav(WavError),
    Mp3(Mp3Error),
    Unknown,
}

impl fmt::Display for FileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FileError::Wav(e) => write!(f, "{e}"),
            FileError::Mp3(e) => write!(f, "{e}"),
            FileError::Unknown => write!(f, "not a WAV or MP3 file"),
        }
    }
}

impl std::error::Error for FileError {}

impl From<WavError> for FileError {
    fn from(e: WavError) -> Self {
        FileError::Wav(e)
    }
}

impl From<Mp3Error> for FileError {
    fn from(e: Mp3Error) -> Self {
        FileError::Mp3(e)
    }
}

#[derive(Debug)]
pub enum AudioFile {
    Wav(WavFile),
    Mp3(Mp3File),
}

impl AudioFile {
    /// Parses by content, not by name: a WAV renamed to `.mp3` still opens.
    pub fn parse(bytes: Vec<u8>) -> Result<AudioFile, FileError> {
        if bytes.len() >= 4 && matches!(&bytes[0..4], b"RIFF" | b"RF64" | b"BW64") {
            return Ok(AudioFile::Wav(WavFile::parse(bytes)?));
        }
        if mp3::looks_like_mp3(&bytes) {
            return Ok(AudioFile::Mp3(Mp3File::parse(bytes)?));
        }
        Err(FileError::Unknown)
    }

    pub fn codec(&self) -> Codec {
        match self {
            AudioFile::Wav(_) => Codec::Wav,
            AudioFile::Mp3(_) => Codec::Mp3,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        match self {
            AudioFile::Wav(f) => f.format().sample_rate,
            AudioFile::Mp3(f) => f.sample_rate(),
        }
    }

    pub fn channels(&self) -> u16 {
        match self {
            AudioFile::Wav(f) => f.format().channels,
            AudioFile::Mp3(f) => f.channels(),
        }
    }

    pub fn frames(&self) -> u64 {
        match self {
            AudioFile::Wav(f) => f.frames(),
            AudioFile::Mp3(f) => f.frames(),
        }
    }

    pub fn bytes(&self) -> &[u8] {
        match self {
            AudioFile::Wav(f) => f.bytes(),
            AudioFile::Mp3(f) => f.bytes(),
        }
    }

    /// The WAV sample layout; `None` for MP3.
    pub fn wav_format(&self) -> Option<WavFormat> {
        match self {
            AudioFile::Wav(f) => Some(f.format()),
            AudioFile::Mp3(_) => None,
        }
    }

    /// Average bitrate in kbps; `None` for WAV.
    pub fn kbps(&self) -> Option<u32> {
        match self {
            AudioFile::Wav(_) => None,
            AudioFile::Mp3(f) => Some(f.kbps()),
        }
    }

    pub fn decode(&self) -> crate::model::Source {
        match self {
            AudioFile::Wav(f) => f.decode(),
            AudioFile::Mp3(f) => f.decode(),
        }
    }

    pub fn extra_chunks(&self) -> Vec<String> {
        match self {
            AudioFile::Wav(f) => f.extra_chunks(),
            AudioFile::Mp3(_) => Vec::new(),
        }
    }

    pub fn truncated(&self) -> bool {
        match self {
            AudioFile::Wav(f) => f.truncated(),
            AudioFile::Mp3(_) => false,
        }
    }

    /// The file `clip` (a clip of this file's source) would leave, as `to`.
    pub fn render(&self, clip: &Clip, to: Codec) -> Result<Vec<u8>, FileError> {
        match (self, to) {
            (AudioFile::Wav(f), Codec::Wav) => Ok(f.render_clip(clip)?),
            (AudioFile::Mp3(f), Codec::Mp3) => Ok(f.render_clip(clip)?),
            (AudioFile::Wav(f), Codec::Mp3) => Ok(mp3::encode_clip(
                &clip.source,
                clip,
                f.format().sample_rate,
                mp3::DEFAULT_KBPS,
                Tags::default(),
            )?),
            (AudioFile::Mp3(f), Codec::Wav) => {
                let ch = f.channels() as usize;
                let s = clip.source.samples();
                let mut out = Vec::with_capacity(clip.len as usize * ch);
                for i in 0..clip.len {
                    let g = clip.gain_at(i);
                    let at = (clip.offset + i) as usize * ch;
                    out.extend(s[at..at + ch].iter().map(|x| *x as f64 * g));
                }
                let format = WavFormat {
                    channels: f.channels(),
                    sample_rate: f.sample_rate(),
                    bits: 24,
                    container_bytes: 3,
                    float: false,
                };
                Ok(encode_simple(format, &out))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn wav(frames: usize) -> AudioFile {
        let fmt = WavFormat {
            channels: 2,
            sample_rate: 44_100,
            bits: 16,
            container_bytes: 2,
            float: false,
        };
        let s: Vec<f64> = (0..frames * 2)
            .map(|i| ((i / 2 % 100) as f64 - 50.0) / 100.0)
            .collect();
        AudioFile::parse(encode_simple(fmt, &s)).unwrap()
    }

    #[test]
    fn picks_the_codec_by_extension() {
        assert_eq!(Codec::for_path(Path::new("a/Kick.MP3")), Some(Codec::Mp3));
        assert_eq!(Codec::for_path(Path::new("kick.wave")), Some(Codec::Wav));
        assert_eq!(Codec::for_path(Path::new("kick")), None);
    }

    #[test]
    fn converts_both_ways() {
        let w = wav(10_000);
        let clip = Clip {
            offset: 1000,
            len: 5000,
            gain: 0.5,
            ..Clip::new(Arc::new(w.decode()), 0)
        };
        let m = AudioFile::parse(w.render(&clip, Codec::Mp3).unwrap()).unwrap();
        assert_eq!(m.codec(), Codec::Mp3);
        assert_eq!(
            (m.frames(), m.sample_rate(), m.channels()),
            (5000, 44_100, 2)
        );
        assert_eq!(m.kbps().map(|k| k.abs_diff(320) <= 4), Some(true));

        let clip = Clip::new(Arc::new(m.decode()), 0);
        let back = AudioFile::parse(m.render(&clip, Codec::Wav).unwrap()).unwrap();
        assert_eq!(back.wav_format().map(|f| f.bits), Some(24));
        assert_eq!(back.frames(), 5000);
    }

    #[test]
    fn rejects_other_files() {
        assert_eq!(
            AudioFile::parse(b"hello".to_vec()).unwrap_err(),
            FileError::Unknown
        );
    }
}
