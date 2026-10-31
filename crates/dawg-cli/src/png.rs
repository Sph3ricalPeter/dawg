//! A tiny PNG writer (stored deflate, no compression library) and the
//! waveform pictures agents look at, since they can't listen.

/// RGB image, row-major.
pub struct Image {
    pub w: usize,
    pub h: usize,
    pub px: Vec<[u8; 3]>,
}

impl Image {
    pub fn new(w: usize, h: usize, bg: [u8; 3]) -> Self {
        Self {
            w,
            h,
            px: vec![bg; w * h],
        }
    }

    pub fn set(&mut self, x: usize, y: usize, c: [u8; 3]) {
        if x < self.w && y < self.h {
            self.px[y * self.w + x] = c;
        }
    }

    pub fn vline(&mut self, x: usize, y0: usize, y1: usize, c: [u8; 3]) {
        for y in y0.min(y1)..=y0.max(y1) {
            self.set(x, y, c);
        }
    }

    pub fn hline(&mut self, y: usize, c: [u8; 3]) {
        for x in 0..self.w {
            self.set(x, y, c);
        }
    }

    pub fn png(&self) -> Vec<u8> {
        let mut raw = Vec::with_capacity((self.w * 3 + 1) * self.h);
        for row in self.px.chunks(self.w) {
            raw.push(0);
            for p in row {
                raw.extend_from_slice(p);
            }
        }
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&(self.w as u32).to_be_bytes());
        ihdr.extend_from_slice(&(self.h as u32).to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        chunk(&mut out, b"IHDR", &ihdr);
        chunk(&mut out, b"IDAT", &zlib_stored(&raw));
        chunk(&mut out, b"IEND", &[]);
        out
    }
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}

fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = data.chunks(65_535).collect();
    for (i, b) in blocks.iter().enumerate() {
        out.push(u8::from(i + 1 == blocks.len()));
        let n = b.len() as u16;
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&(!n).to_le_bytes());
        out.extend_from_slice(b);
    }
    if blocks.is_empty() {
        out.extend_from_slice(&[1, 0, 0, 0xff, 0xff]);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    out.extend_from_slice(&((b << 16) | a).to_be_bytes());
    out
}

const BG: [u8; 3] = [18, 19, 21];
const GRID: [u8; 3] = [48, 50, 56];
const CLIP: [u8; 3] = [255, 77, 77];

/// Lanes of stereo audio (interleaved), one per entry, each `lane_h` tall
/// and `w` wide: min/max per column in the lane's colour, red past 0 dBFS,
/// with a faint line every second.
pub fn waveform(lanes: &[(&[f32], [u8; 3])], rate: u32, w: usize, lane_h: usize) -> Image {
    let mut img = Image::new(w, lane_h * lanes.len().max(1), BG);
    for (n, (samples, color)) in lanes.iter().enumerate() {
        let top = n * lane_h;
        let frames = samples.len() / 2;
        let mid = top + lane_h / 2;
        let half = (lane_h / 2).saturating_sub(2) as f32;
        if frames > 0 {
            let seconds = frames as f64 / rate as f64;
            let mut s = 0.0;
            while s < seconds {
                let x = (s / seconds * w as f64) as usize;
                img.vline(x, top, top + lane_h - 1, GRID);
                s += 1.0;
            }
        }
        img.hline(top + lane_h - 1, GRID);
        for x in 0..w {
            let a = x * frames / w;
            let b = ((x + 1) * frames / w).max(a + 1).min(frames);
            if a >= frames {
                break;
            }
            let (mut lo, mut hi) = (0f32, 0f32);
            for f in a..b {
                let v = 0.5 * (samples[2 * f] + samples[2 * f + 1]);
                lo = lo.min(v);
                hi = hi.max(v);
            }
            let over = hi > 1.0 || lo < -1.0;
            let y0 = (mid as f32 - hi.min(1.0) * half) as usize;
            let y1 = (mid as f32 - lo.max(-1.0) * half) as usize;
            img.vline(x, y0, y1, if over { CLIP } else { *color });
        }
        img.set(0, mid, GRID);
    }
    img
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_valid_png() {
        let s = vec![0.5f32; 2000];
        let png = waveform(&[(&s, [200, 200, 200])], 1000, 64, 32).png();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        // IHDR: 64 x 32.
        assert_eq!(&png[16..24], &[0, 0, 0, 64, 0, 0, 0, 32]);
        assert_eq!(crc32(b"IEND"), 0xae42_6082);
    }
}
