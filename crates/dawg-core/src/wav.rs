//! WAV reading and format-preserving writing.
//!
//! dawg edits files people care about, so this is its own small RIFF codec
//! rather than a generic decoder:
//!
//! - The file keeps its exact format (rate, bit depth, int or float,
//!   channel count and mask) and every chunk dawg doesn't understand, in the
//!   original order.
//! - An untouched file writes back byte for byte. A crop copies the source
//!   sample bytes it keeps, so only frames whose gain changed are re-quantized,
//!   with TPDF dither at 16 bits and below.
//! - Chunks that point into the audio (`cue `, `smpl`, `bext`, `fact`) are
//!   rebased by the crop, and markers that fall outside it are dropped.

use std::fmt;
use std::ops::Range;
use std::sync::Arc;

use serde::Serialize;

use crate::model::{Clip, Source};

const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// Byte offset of `TimeReference` (u64) in a `bext` chunk body.
const BEXT_TIME_REFERENCE: usize = 256 + 32 + 32 + 10 + 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WavError {
    NotWav,
    /// RF64 / BW64 (files over 4 GB).
    Rf64,
    Compressed(u16),
    UnsupportedFormat(String),
    Malformed(&'static str),
    TooLarge,
}

impl fmt::Display for WavError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WavError::NotWav => write!(f, "not a WAV file"),
            WavError::Rf64 => write!(f, "RF64 WAV files (over 4 GB) are not supported yet"),
            WavError::Compressed(tag) => write!(
                f,
                "compressed WAV (format 0x{tag:04X}) is not supported; only PCM and float are"
            ),
            WavError::UnsupportedFormat(s) => write!(f, "unsupported WAV format: {s}"),
            WavError::Malformed(s) => write!(f, "damaged WAV file: {s}"),
            WavError::TooLarge => write!(f, "the result would be over the 4 GB WAV limit"),
        }
    }
}

impl std::error::Error for WavError {}

/// Sample layout of a WAV file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WavFormat {
    pub channels: u16,
    pub sample_rate: u32,
    /// Bits that carry signal (`wValidBitsPerSample` for extensible files).
    pub bits: u16,
    /// Bytes each sample takes in the file.
    pub container_bytes: u16,
    pub float: bool,
}

impl WavFormat {
    fn block_align(&self) -> usize {
        self.container_bytes as usize * self.channels as usize
    }
}

#[derive(Debug, Clone)]
struct ChunkRef {
    id: [u8; 4],
    body: Range<usize>,
}

/// A parsed WAV file and the bytes it came from.
#[derive(Debug)]
pub struct WavFile {
    bytes: Arc<[u8]>,
    format: WavFormat,
    chunks: Vec<ChunkRef>,
    /// Index of the `data` chunk in `chunks`.
    data: usize,
    frames: u64,
    /// The file ended before its `data` chunk did.
    truncated: bool,
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}

fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

fn put_u32(b: &mut [u8], i: usize, v: u32) {
    b[i..i + 4].copy_from_slice(&v.to_le_bytes());
}

fn parse_fmt(b: &[u8]) -> Result<WavFormat, WavError> {
    if b.len() < 16 {
        return Err(WavError::Malformed("fmt chunk is too short"));
    }
    let mut tag = u16_at(b, 0);
    let channels = u16_at(b, 2);
    let sample_rate = u32_at(b, 4);
    let block_align = u16_at(b, 12);
    let bits_per_sample = u16_at(b, 14);
    let mut bits = bits_per_sample;
    if tag == WAVE_FORMAT_EXTENSIBLE {
        if b.len() < 40 {
            return Err(WavError::Malformed("extensible fmt chunk is too short"));
        }
        let valid = u16_at(b, 18);
        if valid != 0 {
            bits = valid;
        }
        tag = u16_at(b, 24);
    }
    match tag {
        WAVE_FORMAT_PCM | WAVE_FORMAT_IEEE_FLOAT => {}
        other => return Err(WavError::Compressed(other)),
    }
    if channels == 0 || sample_rate == 0 {
        return Err(WavError::Malformed("zero channels or sample rate"));
    }
    if block_align == 0 || !block_align.is_multiple_of(channels) {
        return Err(WavError::Malformed(
            "block size does not match channel count",
        ));
    }
    let container_bytes = block_align / channels;
    let float = tag == WAVE_FORMAT_IEEE_FLOAT;
    let ok = if float {
        matches!(container_bytes, 4 | 8)
    } else {
        matches!(container_bytes, 1..=4)
    };
    if !ok || bits == 0 || bits > container_bytes * 8 {
        return Err(WavError::UnsupportedFormat(format!(
            "{bits}-bit {} in {container_bytes}-byte samples",
            if float { "float" } else { "integer" }
        )));
    }
    Ok(WavFormat {
        channels,
        sample_rate,
        bits,
        container_bytes,
        float,
    })
}

impl WavFile {
    pub fn parse(bytes: impl Into<Arc<[u8]>>) -> Result<WavFile, WavError> {
        let bytes: Arc<[u8]> = bytes.into();
        let b = &bytes[..];
        if b.len() < 12 {
            return Err(WavError::NotWav);
        }
        match &b[0..4] {
            b"RIFF" => {}
            b"RF64" | b"BW64" => return Err(WavError::Rf64),
            _ => return Err(WavError::NotWav),
        }
        if &b[8..12] != b"WAVE" {
            return Err(WavError::NotWav);
        }

        // Walk to the end of the file rather than trusting the RIFF size:
        // plenty of writers get it wrong.
        let mut chunks = Vec::new();
        let mut truncated = false;
        let mut pos = 12;
        while pos + 8 <= b.len() {
            let id: [u8; 4] = b[pos..pos + 4].try_into().unwrap();
            let size = u32_at(b, pos + 4) as usize;
            let start = pos + 8;
            let mut end = start.saturating_add(size);
            if end > b.len() {
                if &id != b"data" {
                    // A damaged trailing chunk: keep what came before it.
                    break;
                }
                end = b.len();
                truncated = true;
            }
            chunks.push(ChunkRef {
                id,
                body: start..end,
            });
            pos = end + (size & 1);
        }

        let fmt = chunks
            .iter()
            .find(|c| &c.id == b"fmt ")
            .ok_or(WavError::Malformed("no fmt chunk"))?;
        let format = parse_fmt(&b[fmt.body.clone()])?;
        let data = chunks
            .iter()
            .position(|c| &c.id == b"data")
            .ok_or(WavError::Malformed("no data chunk"))?;
        let frames = (chunks[data].body.len() / format.block_align()) as u64;

        Ok(WavFile {
            bytes,
            format,
            chunks,
            data,
            frames,
            truncated,
        })
    }

    pub fn format(&self) -> WavFormat {
        self.format
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Ids of the chunks other than `fmt ` and `data`, in file order.
    pub fn extra_chunks(&self) -> Vec<String> {
        self.chunks
            .iter()
            .filter(|c| &c.id != b"fmt " && &c.id != b"data")
            .map(|c| String::from_utf8_lossy(&c.id).trim_end().to_string())
            .collect()
    }

    #[cfg(test)]
    fn chunk(&self, id: &[u8; 4]) -> Option<&[u8]> {
        self.chunks
            .iter()
            .find(|c| &c.id == id)
            .map(|c| &self.bytes[c.body.clone()])
    }

    fn data_bytes(&self) -> &[u8] {
        let r = self.chunks[self.data].body.clone();
        &self.bytes[r.start..r.start + self.frames as usize * self.format.block_align()]
    }

    /// Sample `ch` of `frame`, scaled to -1..1 (ints) or as stored (floats).
    #[inline]
    fn sample_f64(&self, data: &[u8], frame: usize, ch: usize) -> f64 {
        let cb = self.format.container_bytes as usize;
        let i = frame * self.format.block_align() + ch * cb;
        let s = &data[i..i + cb];
        if self.format.float {
            return if cb == 4 {
                f32::from_le_bytes(s.try_into().unwrap()) as f64
            } else {
                f64::from_le_bytes(s.try_into().unwrap())
            };
        }
        let v: i64 = match cb {
            1 => s[0] as i64 - 128,
            2 => i16::from_le_bytes([s[0], s[1]]) as i64,
            3 => (i32::from_le_bytes([0, s[0], s[1], s[2]]) >> 8) as i64,
            _ => i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as i64,
        };
        v as f64 / (1u64 << (cb * 8 - 1)) as f64
    }

    /// Decodes to interleaved `f32` for playback and waveforms.
    pub fn decode(&self) -> Source {
        let data = self.data_bytes();
        let ch = self.format.channels as usize;
        let mut out = Vec::with_capacity(self.frames as usize * ch);
        for f in 0..self.frames as usize {
            for c in 0..ch {
                out.push(self.sample_f64(data, f, c) as f32);
            }
        }
        Source::new(self.format.channels, out)
    }

    /// The file as `clip` would leave it: the clip's frames of this source,
    /// with its gain and fades, in this file's format and with its chunks.
    ///
    /// The clip's `offset` and `len` are source frames; `start` is ignored.
    /// Returns the original bytes untouched when the clip keeps everything.
    pub fn render_clip(&self, clip: &Clip) -> Result<Vec<u8>, WavError> {
        assert!(
            clip.offset + clip.len <= self.frames,
            "clip runs past the end of the file"
        );
        if clip.offset == 0 && clip.len == self.frames && clip.is_unity() && !self.truncated {
            return Ok(self.bytes.to_vec());
        }

        let data = self.encode_data(clip);
        let mut out = Vec::with_capacity(data.len() + 4096);
        out.extend_from_slice(b"RIFF\0\0\0\0WAVE");
        for (i, c) in self.chunks.iter().enumerate() {
            let body = &self.bytes[c.body.clone()];
            let rebased;
            let body: &[u8] = if i == self.data {
                &data
            } else {
                match &c.id {
                    b"fact" => {
                        rebased = rebase_fact(body, clip.len);
                        &rebased
                    }
                    b"bext" => {
                        rebased = rebase_bext(body, clip.offset);
                        &rebased
                    }
                    b"cue " => {
                        rebased = rebase_cue(body, clip.offset, clip.len);
                        &rebased
                    }
                    b"smpl" => {
                        rebased = rebase_smpl(body, clip.offset, clip.len);
                        &rebased
                    }
                    _ => body,
                }
            };
            if body.len() > u32::MAX as usize {
                return Err(WavError::TooLarge);
            }
            out.extend_from_slice(&c.id);
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(body);
            if body.len() % 2 == 1 {
                out.push(0);
            }
        }
        let riff = out.len() - 8;
        if riff > u32::MAX as usize {
            return Err(WavError::TooLarge);
        }
        put_u32(&mut out, 4, riff as u32);
        Ok(out)
    }

    /// The `data` chunk body for `clip`. Frames at unity gain are copied
    /// byte for byte; the rest are re-quantized.
    fn encode_data(&self, clip: &Clip) -> Vec<u8> {
        let src = self.data_bytes();
        let fmt = self.format;
        let ba = fmt.block_align();
        let cb = fmt.container_bytes as usize;
        let ch = fmt.channels as usize;
        let mut out = Vec::with_capacity(clip.len as usize * ba);
        let mut dither = Tpdf::new(0x5EED_DA06);
        let dithered = !fmt.float && fmt.bits <= 16;

        for i in 0..clip.len {
            let f = (clip.offset + i) as usize;
            let g = clip.gain_at(i);
            if g == 1.0 {
                out.extend_from_slice(&src[f * ba..(f + 1) * ba]);
                continue;
            }
            for c in 0..ch {
                let x = self.sample_f64(src, f, c) * g;
                if fmt.float {
                    if cb == 4 {
                        out.extend_from_slice(&(x as f32).to_le_bytes());
                    } else {
                        out.extend_from_slice(&x.to_le_bytes());
                    }
                    continue;
                }
                // Quantize at the valid-bit resolution, stored left-aligned
                // in the container.
                let full = (1i64 << (cb * 8 - 1)) as f64;
                let step = (1i64 << (cb as u16 * 8 - fmt.bits)) as f64;
                let mut v = x * full / step;
                if dithered {
                    v += dither.next();
                }
                let max = full / step - 1.0;
                let min = -full / step;
                let q = (v.round().clamp(min, max) * step) as i64;
                match cb {
                    1 => out.push((q + 128) as u8),
                    2 => out.extend_from_slice(&(q as i16).to_le_bytes()),
                    3 => out.extend_from_slice(&(q as i32).to_le_bytes()[..3]),
                    _ => out.extend_from_slice(&(q as i32).to_le_bytes()),
                }
            }
        }
        out
    }
}

/// Triangular dither of ±1 LSB from a fixed-seed generator, so exports are
/// reproducible.
struct Tpdf(u32);

impl Tpdf {
    fn new(seed: u32) -> Self {
        Self(seed)
    }

    fn uniform(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        self.0 as f64 / 4_294_967_296.0
    }

    fn next(&mut self) -> f64 {
        self.uniform() - self.uniform()
    }
}

fn rebase_fact(body: &[u8], frames: u64) -> Vec<u8> {
    let mut b = body.to_vec();
    if b.len() >= 4 {
        put_u32(&mut b, 0, frames.min(u32::MAX as u64) as u32);
    }
    b
}

fn rebase_bext(body: &[u8], offset: u64) -> Vec<u8> {
    let mut b = body.to_vec();
    let i = BEXT_TIME_REFERENCE;
    if b.len() >= i + 8 {
        let lo = u32_at(&b, i) as u64;
        let hi = u32_at(&b, i + 4) as u64;
        let t = ((hi << 32) | lo).wrapping_add(offset);
        put_u32(&mut b, i, t as u32);
        put_u32(&mut b, i + 4, (t >> 32) as u32);
    }
    b
}

/// Cue points: `count`, then 24-byte entries whose `dwSampleOffset` (and,
/// for PCM, `dwPosition`) are frame numbers.
fn rebase_cue(body: &[u8], offset: u64, len: u64) -> Vec<u8> {
    if body.len() < 4 {
        return body.to_vec();
    }
    let count = (u32_at(body, 0) as usize).min((body.len() - 4) / 24);
    let mut out = vec![0; 4];
    let mut kept = 0u32;
    for k in 0..count {
        let e = &body[4 + k * 24..4 + (k + 1) * 24];
        let at = u32_at(e, 20) as u64;
        if at < offset || at > offset + len {
            continue;
        }
        let mut e = e.to_vec();
        put_u32(&mut e, 20, (at - offset) as u32);
        let pos = u32_at(&e, 4) as u64;
        if pos >= offset {
            put_u32(&mut e, 4, (pos - offset) as u32);
        }
        out.extend_from_slice(&e);
        kept += 1;
    }
    put_u32(&mut out, 0, kept);
    out
}

/// Sampler chunk: 36-byte header with the loop count at 28, then 24-byte
/// loops with start and end frames at 8 and 12.
fn rebase_smpl(body: &[u8], offset: u64, len: u64) -> Vec<u8> {
    if body.len() < 36 {
        return body.to_vec();
    }
    let count = (u32_at(body, 28) as usize).min((body.len() - 36) / 24);
    let loops_end = 36 + count * 24;
    let mut out = body[..36].to_vec();
    let mut kept = 0u32;
    for k in 0..count {
        let mut e = body[36 + k * 24..36 + (k + 1) * 24].to_vec();
        let (s, t) = (u32_at(&e, 8) as u64, u32_at(&e, 12) as u64);
        if s < offset || t >= offset + len {
            continue;
        }
        put_u32(&mut e, 8, (s - offset) as u32);
        put_u32(&mut e, 12, (t - offset) as u32);
        out.extend_from_slice(&e);
        kept += 1;
    }
    put_u32(&mut out, 28, kept);
    out.extend_from_slice(&body[loops_end..]);
    out
}

/// Writes a plain WAV (`fmt ` + `data`) from interleaved `f64` samples.
/// Used by tests and for building fixtures; no dither, values are clamped.
pub fn encode_simple(format: WavFormat, samples: &[f64]) -> Vec<u8> {
    let cb = format.container_bytes as usize;
    let ext = format.channels > 2 || format.bits as usize != cb * 8;
    let mut fmt = Vec::new();
    let tag = if format.float {
        WAVE_FORMAT_IEEE_FLOAT
    } else {
        WAVE_FORMAT_PCM
    };
    fmt.extend_from_slice(&(if ext { WAVE_FORMAT_EXTENSIBLE } else { tag }).to_le_bytes());
    fmt.extend_from_slice(&format.channels.to_le_bytes());
    fmt.extend_from_slice(&format.sample_rate.to_le_bytes());
    let ba = format.block_align() as u32;
    fmt.extend_from_slice(&(format.sample_rate * ba).to_le_bytes());
    fmt.extend_from_slice(&(ba as u16).to_le_bytes());
    fmt.extend_from_slice(&((cb * 8) as u16).to_le_bytes());
    if ext {
        fmt.extend_from_slice(&22u16.to_le_bytes());
        fmt.extend_from_slice(&format.bits.to_le_bytes());
        let mask: u32 = (1u32 << format.channels.min(18)) - 1;
        fmt.extend_from_slice(&mask.to_le_bytes());
        fmt.extend_from_slice(&tag.to_le_bytes());
        fmt.extend_from_slice(&[
            0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
        ]);
    }

    let mut data = Vec::new();
    let step = (1i64 << (cb as u16 * 8 - format.bits)) as f64;
    let full = (1i64 << (cb * 8 - 1)) as f64;
    for &x in samples {
        if format.float {
            if cb == 4 {
                data.extend_from_slice(&(x as f32).to_le_bytes());
            } else {
                data.extend_from_slice(&x.to_le_bytes());
            }
            continue;
        }
        let q = ((x * full / step)
            .round()
            .clamp(-full / step, full / step - 1.0)
            * step) as i64;
        match cb {
            1 => data.push((q + 128) as u8),
            2 => data.extend_from_slice(&(q as i16).to_le_bytes()),
            3 => data.extend_from_slice(&(q as i32).to_le_bytes()[..3]),
            _ => data.extend_from_slice(&(q as i32).to_le_bytes()),
        }
    }

    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF\0\0\0\0WAVE");
    for (id, body) in [(b"fmt ", &fmt), (b"data", &data)] {
        out.extend_from_slice(id);
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
        if body.len() % 2 == 1 {
            out.push(0);
        }
    }
    let riff = (out.len() - 8) as u32;
    put_u32(&mut out, 4, riff);
    out
}

/// Inserts a chunk just before `data` in a WAV built by [`encode_simple`].
/// Test helper for metadata pass-through.
pub fn insert_chunk_before_data(wav: &[u8], id: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut at = 12;
    while &wav[at..at + 4] != b"data" {
        let size = u32_at(wav, at + 4) as usize;
        at += 8 + size + (size & 1);
    }
    let mut out = wav[..at].to_vec();
    out.extend_from_slice(id);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    if body.len() % 2 == 1 {
        out.push(0);
    }
    out.extend_from_slice(&wav[at..]);
    let riff = (out.len() - 8) as u32;
    put_u32(&mut out, 4, riff);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(channels: u16, bits: u16, cb: u16, float: bool) -> WavFormat {
        WavFormat {
            channels,
            sample_rate: 44_100,
            bits,
            container_bytes: cb,
            float,
        }
    }

    /// Integer-only test signal in -0.9..0.9.
    fn signal(n: usize) -> Vec<f64> {
        (0..n)
            .map(|i| ((i * 37 % 200) as f64 - 100.0) / 111.0)
            .collect()
    }

    fn all_formats() -> Vec<WavFormat> {
        vec![
            fmt(1, 8, 1, false),
            fmt(1, 16, 2, false),
            fmt(2, 16, 2, false),
            fmt(2, 24, 3, false),
            fmt(2, 20, 3, false),
            fmt(1, 32, 4, false),
            fmt(2, 32, 4, true),
            fmt(1, 64, 8, true),
            fmt(6, 24, 3, false),
        ]
    }

    #[test]
    fn parses_every_supported_format() {
        for f in all_formats() {
            let n = 1000 * f.channels as usize;
            let w = WavFile::parse(encode_simple(f, &signal(n))).unwrap();
            assert_eq!(w.format(), f);
            assert_eq!(w.frames(), 1000);
            let s = w.decode();
            assert_eq!(s.channels(), f.channels);
            assert_eq!(s.frames(), 1000);
        }
    }

    #[test]
    fn untouched_is_bit_identical() {
        for f in all_formats() {
            let bytes = encode_simple(f, &signal(900 * f.channels as usize));
            let bytes = insert_chunk_before_data(&bytes, b"LIST", b"INFOISFT\x05\0\0\0dawg\0");
            let w = WavFile::parse(bytes.clone()).unwrap();
            let src = Arc::new(w.decode());
            let out = w.render_clip(&Clip::new(src, 0)).unwrap();
            assert_eq!(out, bytes, "{f:?}");
        }
    }

    #[test]
    fn crop_is_a_slice_of_the_source_samples() {
        for f in all_formats() {
            let ba = f.block_align();
            let bytes = encode_simple(f, &signal(1000 * f.channels as usize));
            let w = WavFile::parse(bytes).unwrap();
            let src = Arc::new(w.decode());
            let clip = Clip {
                offset: 123,
                len: 456,
                ..Clip::new(src, 0)
            };
            let out = WavFile::parse(w.render_clip(&clip).unwrap()).unwrap();
            assert_eq!(out.format(), f);
            assert_eq!(out.frames(), 456);
            assert_eq!(
                out.data_bytes(),
                &w.data_bytes()[123 * ba..579 * ba],
                "{f:?}"
            );
        }
    }

    #[test]
    fn gain_scales_samples() {
        let f = fmt(1, 32, 4, true);
        let w = WavFile::parse(encode_simple(f, &signal(100))).unwrap();
        let src = Arc::new(w.decode());
        let clip = Clip {
            gain: 0.5,
            ..Clip::new(src.clone(), 0)
        };
        let out = WavFile::parse(w.render_clip(&clip).unwrap())
            .unwrap()
            .decode();
        for (a, b) in out.samples().iter().zip(src.samples()) {
            assert_eq!(*a, b * 0.5);
        }
    }

    #[test]
    fn gain_on_24_bit_is_within_one_lsb() {
        let f = fmt(2, 24, 3, false);
        let w = WavFile::parse(encode_simple(f, &signal(400))).unwrap();
        let src = Arc::new(w.decode());
        let clip = Clip {
            gain: 0.7,
            ..Clip::new(src.clone(), 0)
        };
        let out = WavFile::parse(w.render_clip(&clip).unwrap())
            .unwrap()
            .decode();
        let lsb = 1.0 / 8_388_608.0;
        for (a, b) in out.samples().iter().zip(src.samples()) {
            assert!((a - b * 0.7).abs() <= lsb, "{a} vs {}", b * 0.7);
        }
    }

    #[test]
    fn dithers_16_bit_only_where_gain_changed() {
        let f = fmt(1, 16, 2, false);
        let w = WavFile::parse(encode_simple(f, &signal(1000))).unwrap();
        let src = Arc::new(w.decode());
        let clip = Clip {
            fade_in: 100,
            ..Clip::new(src, 0)
        };
        let out = WavFile::parse(w.render_clip(&clip).unwrap()).unwrap();
        // After the fade the bytes are the source's.
        assert_eq!(out.data_bytes()[200..], w.data_bytes()[200..]);
        // The first frame is faded to silence, give or take the dither.
        let first = i16::from_le_bytes([out.data_bytes()[0], out.data_bytes()[1]]);
        assert!(first.abs() <= 1, "{first}");
    }

    #[test]
    fn eight_bit_round_trips_silence() {
        let f = fmt(1, 8, 1, false);
        let w = WavFile::parse(encode_simple(f, &[0.0; 10])).unwrap();
        assert!(w.decode().samples().iter().all(|&s| s == 0.0));
    }

    #[test]
    fn rebases_markers_on_crop() {
        let f = fmt(1, 16, 2, false);
        let base = encode_simple(f, &signal(1000));
        // Two cue points, at 50 (cut away) and 300 (kept).
        let mut cue = 2u32.to_le_bytes().to_vec();
        for (id, at) in [(1u32, 50u32), (2, 300)] {
            for v in [id, at] {
                cue.extend_from_slice(&v.to_le_bytes());
            }
            cue.extend_from_slice(b"data");
            for v in [0u32, 0, at] {
                cue.extend_from_slice(&v.to_le_bytes());
            }
        }
        let mut bext = vec![0u8; 602];
        bext[BEXT_TIME_REFERENCE..BEXT_TIME_REFERENCE + 8]
            .copy_from_slice(&1_000_000u64.to_le_bytes());
        let mut smpl = vec![0u8; 36];
        smpl[28..32].copy_from_slice(&1u32.to_le_bytes());
        for v in [0u32, 0, 400, 600, 0, 0] {
            smpl.extend_from_slice(&v.to_le_bytes());
        }
        let bytes = insert_chunk_before_data(&base, b"cue ", &cue);
        let bytes = insert_chunk_before_data(&bytes, b"bext", &bext);
        let bytes = insert_chunk_before_data(&bytes, b"smpl", &smpl);
        let w = WavFile::parse(bytes).unwrap();
        assert_eq!(w.extra_chunks(), ["cue", "bext", "smpl"]);

        let src = Arc::new(w.decode());
        let clip = Clip {
            offset: 100,
            len: 800,
            ..Clip::new(src, 0)
        };
        let out = WavFile::parse(w.render_clip(&clip).unwrap()).unwrap();
        let cue = out.chunk(b"cue ").unwrap();
        assert_eq!(u32_at(cue, 0), 1);
        assert_eq!(u32_at(cue, 4), 2);
        assert_eq!(u32_at(cue, 4 + 20), 200);
        let bext = out.chunk(b"bext").unwrap();
        assert_eq!(
            u64::from_le_bytes(
                bext[BEXT_TIME_REFERENCE..BEXT_TIME_REFERENCE + 8]
                    .try_into()
                    .unwrap()
            ),
            1_000_100
        );
        let smpl = out.chunk(b"smpl").unwrap();
        assert_eq!(u32_at(smpl, 28), 1);
        assert_eq!((u32_at(smpl, 36 + 8), u32_at(smpl, 36 + 12)), (300, 500));

        // A crop through the loop drops it.
        let clip = Clip {
            offset: 450,
            len: 100,
            ..clip
        };
        let out = WavFile::parse(w.render_clip(&clip).unwrap()).unwrap();
        assert_eq!(u32_at(out.chunk(b"smpl").unwrap(), 28), 0);
        assert_eq!(u32_at(out.chunk(b"cue ").unwrap(), 0), 0);
    }

    #[test]
    fn reads_truncated_data_and_rejects_junk() {
        let f = fmt(1, 16, 2, false);
        let bytes = encode_simple(f, &signal(100));
        let w = WavFile::parse(bytes[..bytes.len() - 51].to_vec()).unwrap();
        assert!(w.truncated());
        assert_eq!(w.frames(), 74);
        assert_eq!(
            WavFile::parse(b"hello".to_vec()).unwrap_err(),
            WavError::NotWav
        );
        let mut rf = bytes.clone();
        rf[0..4].copy_from_slice(b"RF64");
        assert_eq!(WavFile::parse(rf).unwrap_err(), WavError::Rf64);
        let mut adpcm = bytes;
        adpcm[20..22].copy_from_slice(&2u16.to_le_bytes());
        assert_eq!(WavFile::parse(adpcm).unwrap_err(), WavError::Compressed(2));
    }

    #[test]
    fn odd_sized_chunks_keep_padding() {
        let f = fmt(1, 8, 1, false);
        let bytes = encode_simple(f, &signal(101));
        let bytes = insert_chunk_before_data(&bytes, b"note", b"abc");
        let w = WavFile::parse(bytes.clone()).unwrap();
        assert_eq!(w.frames(), 101);
        let src = Arc::new(w.decode());
        let clip = Clip {
            offset: 1,
            len: 99,
            ..Clip::new(src, 0)
        };
        let out = WavFile::parse(w.render_clip(&clip).unwrap()).unwrap();
        assert_eq!(out.chunk(b"note").unwrap(), b"abc");
        assert_eq!(out.frames(), 99);
    }
}
