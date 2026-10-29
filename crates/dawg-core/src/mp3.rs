//! MP3 reading (Symphonia) and writing (LAME).
//!
//! MP3 can't be edited in place the way [`crate::wav`] edits WAV: any change
//! means decoding and encoding again. So the rules are looser but still
//! careful:
//!
//! - An untouched file saves byte for byte.
//! - Decoding is gapless (the LAME/Xing info tag's delay and padding are
//!   trimmed), and every file dawg writes carries that tag, so saving over an
//!   MP3 keeps its length to the frame instead of growing by the encoder
//!   delay each time.
//! - The leading ID3v2 tag and trailing ID3v1 tag (title, artist, cover art)
//!   are copied over unchanged.
//! - It re-encodes at the file's own sample rate and at the standard
//!   constant bitrate nearest its average, so a 192 kbps file stays 192.
//!
//! LAME is LGPL; see `THIRD_PARTY.md`.

use std::fmt;
use std::io::Cursor;
use std::ops::Range;
use std::sync::Arc;

use mp3lame_encoder::{Bitrate, Builder, FlushGap, InterleavedPcm, MonoPcm, Quality};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_MP3};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::model::{Clip, Source};

/// Bitrate used when the source isn't an MP3 (a WAV exported as MP3).
pub const DEFAULT_KBPS: u32 = 320;

/// Sample rates MP3 can hold (MPEG 1, 2 and 2.5).
const RATES: [u32; 9] = [
    8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mp3Error {
    NotMp3,
    Malformed(String),
    TooManyChannels(u16),
    Encoder(String),
}

impl fmt::Display for Mp3Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Mp3Error::NotMp3 => write!(f, "not an MP3 file"),
            Mp3Error::Malformed(s) => write!(f, "damaged MP3 file: {s}"),
            Mp3Error::TooManyChannels(n) => write!(
                f,
                "MP3 holds at most 2 channels and this audio has {n}; export it as WAV"
            ),
            Mp3Error::Encoder(s) => write!(f, "MP3 encoder: {s}"),
        }
    }
}

impl std::error::Error for Mp3Error {}

/// A decoded MP3 file and the bytes it came from.
#[derive(Debug)]
pub struct Mp3File {
    bytes: Arc<[u8]>,
    sample_rate: u32,
    channels: u16,
    /// Average bitrate of the audio frames, in kbps.
    kbps: u32,
    source: Source,
    id3v2: Range<usize>,
    id3v1: Range<usize>,
}

/// True when `b` starts the way an MP3 does: an ID3v2 tag or a frame sync.
pub fn looks_like_mp3(b: &[u8]) -> bool {
    b.starts_with(b"ID3") || (b.len() >= 2 && b[0] == 0xFF && b[1] & 0xE0 == 0xE0)
}

/// The leading ID3v2 tag, header and footer included.
fn id3v2_range(b: &[u8]) -> Range<usize> {
    if b.len() < 10 || !b.starts_with(b"ID3") || b[6..10].iter().any(|x| x & 0x80 != 0) {
        return 0..0;
    }
    let size = b[6..10]
        .iter()
        .fold(0usize, |acc, x| (acc << 7) | *x as usize);
    let footer = if b[5] & 0x10 != 0 { 10 } else { 0 };
    0..(10 + size + footer).min(b.len())
}

/// The trailing 128-byte ID3v1 tag.
fn id3v1_range(b: &[u8], after: usize) -> Range<usize> {
    let n = b.len();
    if n >= after + 128 && &b[n - 128..n - 125] == b"TAG" {
        n - 128..n
    } else {
        n..n
    }
}

/// Length of the Xing/Info frame at the start of the audio, or 0. It holds
/// no sound, so it doesn't count towards the bitrate.
fn info_frame_len(b: &[u8]) -> usize {
    if b.len() < 4 || b[0] != 0xFF || b[1] & 0xE0 != 0xE0 || (b[1] >> 1) & 3 != 1 {
        return 0;
    }
    let version = (b[1] >> 3) & 3; // 3: MPEG1, 2: MPEG2, 0: MPEG2.5
    let mpeg1 = version == 3;
    let kbps_table: [usize; 15] = if mpeg1 {
        [
            0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
        ]
    } else {
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    };
    let (Some(&kbps), Some(&rate)) = (
        kbps_table.get((b[2] >> 4) as usize),
        [44_100usize, 48_000, 32_000].get(((b[2] >> 2) & 3) as usize),
    ) else {
        return 0;
    };
    let rate = match version {
        3 => rate,
        2 => rate / 2,
        _ => rate / 4,
    };
    let mono = b[3] >> 6 == 3;
    let side = match (mpeg1, mono) {
        (true, true) => 17,
        (true, false) => 32,
        (false, true) => 9,
        (false, false) => 17,
    };
    let tag = &b[(4 + side).min(b.len())..(8 + side).min(b.len())];
    if kbps == 0 || (tag != b"Xing" && tag != b"Info") {
        return 0;
    }
    let pad = ((b[2] >> 1) & 1) as usize;
    (if mpeg1 { 144_000 } else { 72_000 }) * kbps / rate + pad
}

impl Mp3File {
    pub fn parse(bytes: impl Into<Arc<[u8]>>) -> Result<Mp3File, Mp3Error> {
        let bytes: Arc<[u8]> = bytes.into();
        if !looks_like_mp3(&bytes) {
            return Err(Mp3Error::NotMp3);
        }
        let id3v2 = id3v2_range(&bytes);
        let id3v1 = id3v1_range(&bytes, id3v2.end);
        let (sample_rate, channels, samples, coded) = decode(bytes.clone())?;
        let audio = &bytes[id3v2.end..id3v1.start];
        let audio_bytes = audio.len().saturating_sub(info_frame_len(audio)) as u64;
        let kbps = (audio_bytes * 8 * sample_rate as u64)
            .checked_div(coded * 1000)
            .unwrap_or(0) as u32;
        Ok(Mp3File {
            sample_rate,
            channels,
            kbps,
            source: Source::new(channels, samples),
            id3v2,
            id3v1,
            bytes,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn frames(&self) -> u64 {
        self.source.frames()
    }

    /// Average bitrate in kbps (over every coded frame, so the encoder's
    /// delay and padding don't inflate it).
    pub fn kbps(&self) -> u32 {
        self.kbps
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn decode(&self) -> Source {
        self.source.clone()
    }

    /// The tags dawg copies into a re-encoded file.
    pub fn tags(&self) -> Tags<'_> {
        Tags {
            id3v2: &self.bytes[self.id3v2.clone()],
            id3v1: &self.bytes[self.id3v1.clone()],
        }
    }

    /// The file as `clip` would leave it. Returns the original bytes when
    /// the clip keeps everything.
    pub fn render_clip(&self, clip: &Clip) -> Result<Vec<u8>, Mp3Error> {
        if clip.offset == 0 && clip.len == self.frames() && clip.is_unity() {
            return Ok(self.bytes.to_vec());
        }
        encode_clip(&self.source, clip, self.sample_rate, self.kbps, self.tags())
    }
}

/// Raw tag bytes to put around the audio.
#[derive(Debug, Clone, Copy, Default)]
pub struct Tags<'a> {
    pub id3v2: &'a [u8],
    pub id3v1: &'a [u8],
}

/// Decodes to (rate, channels, interleaved samples, coded frames including
/// the trimmed delay and padding).
fn decode(bytes: Arc<[u8]>) -> Result<(u32, u16, Vec<f32>, u64), Mp3Error> {
    let malformed = |e: SymError| Mp3Error::Malformed(e.to_string());
    let mss = MediaSourceStream::new(
        Box::new(Cursor::new(bytes)),
        MediaSourceStreamOptions::default(),
    );
    let mut hint = Hint::new();
    hint.with_extension("mp3");
    let fmt_opts = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &MetadataOptions::default())
        .map_err(|_| Mp3Error::NotMp3)?;
    let mut reader = probed.format;
    let track = reader
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec == CODEC_TYPE_MP3)
        .ok_or(Mp3Error::NotMp3)?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(malformed)?;

    let mut rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut channels = track
        .codec_params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or(0);
    let mut out = Vec::new();
    let mut coded = 0u64;
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match reader.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => {
                // A damaged tail: keep what decoded.
                if out.is_empty() {
                    return Err(malformed(e));
                }
                break;
            }
        };
        if packet.track_id() != track_id {
            continue;
        }
        coded += packet.block_dur();
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // A corrupt frame: skip it, like players do.
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(malformed(e)),
        };
        let spec = *decoded.spec();
        let ch = spec.channels.count() as u16;
        if channels == 0 {
            channels = ch;
        }
        if rate == 0 {
            rate = spec.rate;
        }
        if ch != channels {
            return Err(Mp3Error::Malformed(
                "the channel count changes partway".into(),
            ));
        }
        if decoded.frames() == 0 {
            continue;
        }
        let b = match &mut buf {
            Some(b) if b.capacity() >= decoded.capacity() * ch as usize => b,
            _ => buf.insert(SampleBuffer::new(decoded.capacity() as u64, spec)),
        };
        b.copy_interleaved_ref(decoded);
        out.extend_from_slice(b.samples());
    }
    if channels == 0 || rate == 0 {
        return Err(Mp3Error::NotMp3);
    }
    Ok((rate, channels, out, coded))
}

/// The standard bitrate nearest `kbps` that the output rate allows. Very
/// low bitrates go up to the lowest one whose frames can hold the info tag,
/// since without the tag the next decode would gain the encoder delay.
fn bitrate_for(kbps: u32, out_rate: u32, channels: u16) -> Bitrate {
    use Bitrate::*;
    let max = match out_rate {
        r if r >= 32_000 => 320,
        r if r >= 16_000 => 160,
        _ => 64,
    };
    let all = [
        (32, Kbps32),
        (40, Kbps40),
        (48, Kbps48),
        (64, Kbps64),
        (80, Kbps80),
        (96, Kbps96),
        (112, Kbps112),
        (128, Kbps128),
        (160, Kbps160),
        (192, Kbps192),
        (224, Kbps224),
        (256, Kbps256),
        (320, Kbps320),
    ];
    // LAME's info tag: frame header, side info and 156 bytes of tag.
    let mpeg1 = out_rate >= 32_000;
    let side = match (mpeg1, channels) {
        (true, 1) => 17,
        (true, _) => 32,
        (false, 1) => 9,
        (false, _) => 17,
    };
    let per_kbps = if mpeg1 { 144_000 } else { 72_000 };
    let min = (4 + side + 156) * out_rate as u64;
    let min = min.div_ceil(per_kbps) as u32;
    let want = kbps.max(min).clamp(32, max);
    all.iter()
        .filter(|(k, _)| *k <= max && *k >= min.min(max))
        .min_by_key(|(k, _)| k.abs_diff(want))
        .map(|(_, b)| *b)
        .unwrap_or(Kbps128)
}

/// The MP3 rate a `rate` source is encoded at: its own when MP3 has it,
/// otherwise the nearest one (LAME resamples).
pub fn output_rate(rate: u32) -> u32 {
    if RATES.contains(&rate) {
        rate
    } else if rate > 48_000 {
        if rate.is_multiple_of(11_025) {
            44_100
        } else {
            48_000
        }
    } else {
        RATES.iter().copied().find(|r| *r >= rate).unwrap_or(48_000)
    }
}

/// Encodes the frames `clip` plays from `source` (with its gain and fades)
/// at `kbps` constant bitrate, wrapped in `tags`.
pub fn encode_clip(
    source: &Source,
    clip: &Clip,
    rate: u32,
    kbps: u32,
    tags: Tags<'_>,
) -> Result<Vec<u8>, Mp3Error> {
    let ch = source.channels();
    if ch > 2 {
        return Err(Mp3Error::TooManyChannels(ch));
    }
    let enc_err = |e: &dyn fmt::Display| Mp3Error::Encoder(e.to_string());
    let out_rate = output_rate(rate);
    let mut b = Builder::new().ok_or_else(|| Mp3Error::Encoder("out of memory".into()))?;
    b.set_num_channels(ch as u8).map_err(|e| enc_err(&e))?;
    b.set_sample_rate(rate).map_err(|e| enc_err(&e))?;
    b.set_output_sample_rate(std::num::NonZeroU32::new(out_rate))
        .map_err(|e| enc_err(&e))?;
    b.set_brate(bitrate_for(kbps, out_rate, ch))
        .map_err(|e| enc_err(&e))?;
    b.set_quality(Quality::Best).map_err(|e| enc_err(&e))?;
    // The info tag carries the delay and padding for gapless decoding.
    b.set_to_write_vbr_tag(true).map_err(|e| enc_err(&e))?;
    let mut enc = b.build().map_err(|e| enc_err(&e))?;

    let n = ch as usize;
    let s = source.samples();
    let mut out = Vec::with_capacity(tags.id3v2.len() + clip.len as usize * n / 4 + 8192);
    out.extend_from_slice(tags.id3v2);
    let audio_start = out.len();

    const BLOCK: u64 = 8192;
    let mut pcm = Vec::with_capacity(BLOCK as usize * n);
    let mut i = 0;
    while i < clip.len {
        let end = (i + BLOCK).min(clip.len);
        pcm.clear();
        for k in i..end {
            let g = clip.gain_at(k);
            let f = (clip.offset + k) as usize * n;
            for x in &s[f..f + n] {
                pcm.push(if g == 1.0 { *x } else { (*x as f64 * g) as f32 });
            }
        }
        out.reserve(mp3lame_encoder::max_required_buffer_size(pcm.len()));
        let r = if n == 2 {
            enc.encode_to_vec(InterleavedPcm(&pcm[..]), &mut out)
        } else {
            enc.encode_to_vec(MonoPcm(&pcm[..]), &mut out)
        };
        r.map_err(|e| enc_err(&e))?;
        i = end;
    }
    out.reserve(7200);
    enc.flush_to_vec::<FlushGap>(&mut out)
        .map_err(|e| enc_err(&e))?;

    // LAME left room for the info tag in the first frame; fill it in now
    // that the delay, padding and frame count are known.
    let mut tag = Vec::with_capacity(enc.lame_tag_size());
    if enc.lame_tag_encode_to_vec(&mut tag).is_some() && out.len() >= audio_start + tag.len() {
        out[audio_start..audio_start + tag.len()].copy_from_slice(&tag);
    }
    out.extend_from_slice(tags.id3v1);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 441 Hz-ish triangle, integer arithmetic only.
    fn triangle(frames: usize, channels: u16) -> Source {
        let mut v = Vec::with_capacity(frames * channels as usize);
        for f in 0..frames {
            let p = (f % 100) as i32;
            let t = if p < 50 { p - 25 } else { 75 - p };
            for c in 0..channels {
                v.push(t as f32 / 50.0 * if c == 0 { 1.0 } else { 0.5 });
            }
        }
        Source::new(channels, v)
    }

    fn encode(src: &Source, rate: u32, tags: Tags<'_>) -> Vec<u8> {
        let clip = Clip::new(Arc::new(src.clone()), 0);
        encode_clip(src, &clip, rate, 192, tags).unwrap()
    }

    #[test]
    fn round_trip_keeps_length_and_shape() {
        for ch in [1, 2] {
            let src = triangle(44_100, ch);
            let bytes = encode(&src, 44_100, Tags::default());
            let f = Mp3File::parse(bytes).unwrap();
            assert_eq!(f.channels(), ch);
            assert_eq!(f.sample_rate(), 44_100);
            assert_eq!(f.frames(), 44_100, "gapless decode keeps the length");
            assert!((188..=196).contains(&f.kbps()), "{} kbps", f.kbps());
            // The decoded wave lines up with the source (no delay).
            let a = src.samples();
            let b = f.decode();
            let b = b.samples();
            let err: f64 = a
                .iter()
                .zip(b)
                .skip(2000)
                .take(40_000)
                .map(|(x, y)| ((x - y) as f64).powi(2))
                .sum::<f64>()
                / 40_000.0;
            assert!(err < 1e-4, "mean square error {err}");
        }
    }

    #[test]
    fn untouched_saves_byte_identical_and_edits_keep_tags() {
        let src = triangle(20_000, 2);
        let mut id3 = b"ID3\x04\x00\x00\x00\x00\x00\x0a".to_vec();
        id3.extend_from_slice(b"TIT2\x00\x00\x00\x00\x00\x00");
        let mut v1 = b"TAG".to_vec();
        v1.resize(128, b'x');
        let bytes = encode(
            &src,
            48_000,
            Tags {
                id3v2: &id3,
                id3v1: &v1,
            },
        );
        let f = Mp3File::parse(bytes.clone()).unwrap();
        assert_eq!(f.frames(), 20_000);
        let mut clip = Clip::new(Arc::new(f.decode()), 0);
        assert_eq!(f.render_clip(&clip).unwrap(), bytes);

        clip.offset = 5_000;
        clip.len = 10_000;
        clip.gain = 0.5;
        let saved = f.render_clip(&clip).unwrap();
        assert!(saved.starts_with(&id3));
        assert!(saved.ends_with(&v1));
        let g = Mp3File::parse(saved).unwrap();
        assert_eq!(g.frames(), 10_000);
        assert_eq!(g.sample_rate(), 48_000);
        // A short sound keeps its bitrate across saves.
        assert!(f.kbps().abs_diff(192) <= 4, "{} kbps", f.kbps());
        assert!(g.kbps().abs_diff(192) <= 4, "{} kbps", g.kbps());
    }

    #[test]
    fn odd_rates_and_wide_files() {
        assert_eq!(output_rate(96_000), 48_000);
        assert_eq!(output_rate(88_200), 44_100);
        assert_eq!(output_rate(44_100), 44_100);
        assert_eq!(output_rate(30_000), 32_000);
        let src = triangle(1000, 2);
        let clip = Clip::new(Arc::new(src.clone()), 0);
        let f = Mp3File::parse(encode_clip(&src, &clip, 96_000, 320, Tags::default()).unwrap())
            .unwrap();
        assert_eq!(f.sample_rate(), 48_000);
        // Low-bitrate speech: still gapless.
        for (rate, ch) in [(22_050, 1), (24_000, 2), (32_000, 2), (8_000, 1)] {
            let src = triangle(rate as usize / 2, ch);
            let clip = Clip::new(Arc::new(src.clone()), 0);
            let bytes = encode_clip(&src, &clip, rate, 32, Tags::default()).unwrap();
            let f = Mp3File::parse(bytes).unwrap();
            assert_eq!(
                (f.sample_rate(), f.frames()),
                (rate, src.frames()),
                "{rate} Hz"
            );
        }
        let wide = Source::new(4, vec![0.0; 400]);
        let clip = Clip::new(Arc::new(wide.clone()), 0);
        assert_eq!(
            encode_clip(&wide, &clip, 48_000, 320, Tags::default()),
            Err(Mp3Error::TooManyChannels(4))
        );
    }

    #[test]
    fn rejects_other_files() {
        assert_eq!(
            Mp3File::parse(b"RIFF\0\0\0\0WAVE".to_vec()).unwrap_err(),
            Mp3Error::NotMp3
        );
    }
}
