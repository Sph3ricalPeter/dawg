//! Listening tools for agents (and the UI): a model can't hear, so it reads
//! numbers. [`analyze`] measures interleaved audio: peak, RMS, integrated
//! loudness (ITU-R BS.1770 / EBU R128, gated), loudness over time, where the
//! sound starts and stops, onsets and brightness.

use serde::Serialize;

/// Below this a window counts as silence, in dBFS.
const SILENCE_DB: f64 = -60.0;
/// Length of one loudness-over-time step, in seconds.
const STEP_S: f64 = 0.1;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub seconds: f64,
    pub channels: u16,
    pub sample_rate: u32,
    /// Sample peak, dBFS; `None` when silent.
    pub peak_db: Option<f64>,
    /// RMS over the whole audio, dBFS.
    pub rms_db: Option<f64>,
    /// Integrated loudness (gated), LUFS; `None` when too short or silent.
    pub lufs: Option<f64>,
    /// Loudest 3 s window (short-term loudness), LUFS.
    pub max_short_term_lufs: Option<f64>,
    /// Peak-to-RMS ratio, dB: high for transients, low for pads.
    pub crest_db: Option<f64>,
    /// First and last moment above -60 dBFS, seconds.
    pub sound_from: Option<f64>,
    pub sound_to: Option<f64>,
    /// Times (seconds) where the level jumps: hits and attacks.
    pub onsets: Vec<f64>,
    /// Spectral centroid, Hz: higher is brighter.
    pub centroid_hz: Option<f64>,
    /// RMS level per 100 ms step, dBFS (-120 for silence), for the shape
    /// of the sound over time.
    pub rms_curve_db: Vec<f64>,
}

fn db(x: f64) -> Option<f64> {
    (x > 0.0).then(|| 20.0 * x.log10())
}

/// A biquad with its own state, for the K-weighting filter.
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    z: [f64; 2],
}

impl Biquad {
    fn tick(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

/// BS.1770's K-weighting at `rate`: a high shelf (+4 dB above ~1.7 kHz) and
/// a high-pass at ~38 Hz, designed for any rate as in libebur128.
fn k_weighting(rate: f64) -> [Biquad; 2] {
    let shelf = {
        let (f0, g, q) = (
            1_681.974_450_955_533,
            3.999_843_853_973_347,
            0.707_175_236_955_419_6,
        );
        let k = (std::f64::consts::PI * f0 / rate).tan();
        let vh = 10f64.powf(g / 20.0);
        let vb = vh.powf(0.499_666_774_154_541_6);
        let a0 = 1.0 + k / q + k * k;
        Biquad {
            b: [
                (vh + vb * k / q + k * k) / a0,
                2.0 * (k * k - vh) / a0,
                (vh - vb * k / q + k * k) / a0,
            ],
            a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
            z: [0.0; 2],
        }
    };
    let hp = {
        let (f0, q) = (38.135_470_876_024_44, 0.500_327_037_323_877_3);
        let k = (std::f64::consts::PI * f0 / rate).tan();
        let a0 = 1.0 + k / q + k * k;
        Biquad {
            b: [1.0, -2.0, 1.0],
            a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
            z: [0.0; 2],
        }
    };
    [shelf, hp]
}

/// Gated integrated loudness from 400 ms block powers (BS.1770-4).
fn integrated(blocks: &[f64]) -> Option<f64> {
    let lufs = |p: f64| -0.691 + 10.0 * p.log10();
    let abs: Vec<f64> = blocks
        .iter()
        .copied()
        .filter(|&p| p > 0.0 && lufs(p) > -70.0)
        .collect();
    if abs.is_empty() {
        return None;
    }
    let rel = lufs(abs.iter().sum::<f64>() / abs.len() as f64) - 10.0;
    let gated: Vec<f64> = abs.into_iter().filter(|&p| lufs(p) > rel).collect();
    (!gated.is_empty()).then(|| lufs(gated.iter().sum::<f64>() / gated.len() as f64))
}

/// Measures `samples` (interleaved, `channels` wide) at `rate`.
pub fn analyze(samples: &[f32], channels: u16, rate: u32) -> Analysis {
    let ch = channels.max(1) as usize;
    let frames = samples.len() / ch;
    let r = rate as f64;
    let mut peak = 0f64;
    let mut sum = 0f64;
    for &x in samples {
        let x = x as f64;
        peak = peak.max(x.abs());
        sum += x * x;
    }
    let rms = if samples.is_empty() {
        0.0
    } else {
        (sum / samples.len() as f64).sqrt()
    };

    // K-weighted power per channel, summed (weights 1 for L, R, C), in
    // 100 ms steps: 400 ms blocks are 4 steps, 3 s windows 30.
    let step = ((r * STEP_S).round() as usize).max(1);
    let mut filters: Vec<[Biquad; 2]> = (0..ch.min(5)).map(|_| k_weighting(r)).collect();
    let mut kpow = Vec::with_capacity(frames / step + 1);
    let mut curve = Vec::with_capacity(frames / step + 1);
    let mut acc = 0f64;
    let mut raw = 0f64;
    for f in 0..frames {
        for (c, filt) in filters.iter_mut().enumerate() {
            let x = samples[f * ch + c] as f64;
            let shelved = filt[0].tick(x);
            let y = filt[1].tick(shelved);
            acc += y * y;
            raw += x * x;
        }
        if (f + 1) % step == 0 || f + 1 == frames {
            let n = ((f % step) + 1) as f64;
            kpow.push(acc / n);
            curve.push((raw / (n * filters.len().max(1) as f64)).sqrt());
            acc = 0.0;
            raw = 0.0;
        }
    }
    let window = |n: usize| -> Vec<f64> {
        if kpow.len() < n {
            return Vec::new();
        }
        (0..=kpow.len() - n)
            .map(|i| kpow[i..i + n].iter().sum::<f64>() / n as f64)
            .collect()
    };
    let lufs = integrated(&window(4));
    let max_st = window(30)
        .into_iter()
        .fold(None::<f64>, |m, p| Some(m.map_or(p, |m: f64| m.max(p))))
        .filter(|&p| p > 0.0)
        .map(|p| -0.691 + 10.0 * p.log10());

    let curve_db: Vec<f64> = curve.iter().map(|&x| db(x).unwrap_or(-120.0)).collect();
    let loud: Vec<usize> = curve_db
        .iter()
        .enumerate()
        .filter(|(_, &d)| d > SILENCE_DB)
        .map(|(i, _)| i)
        .collect();
    let sound_from = loud.first().map(|&i| i as f64 * STEP_S);
    let sound_to = loud
        .last()
        .map(|&i| ((i + 1) as f64 * STEP_S).min(frames as f64 / r));

    // Onsets: 10 ms energy jumping 9 dB over the last 50 ms.
    let hop = ((r * 0.01).round() as usize).max(1);
    let energy: Vec<f64> = (0..frames.div_ceil(hop))
        .map(|k| {
            let a = k * hop * ch;
            let b = ((k + 1) * hop * ch).min(samples.len());
            let e = samples[a..b]
                .iter()
                .map(|&x| (x as f64).powi(2))
                .sum::<f64>();
            e / (b - a).max(1) as f64
        })
        .collect();
    let mut onsets = Vec::new();
    let mut last = f64::NEG_INFINITY;
    for k in 1..energy.len() {
        let before =
            energy[k.saturating_sub(5)..k].iter().sum::<f64>() / (k - k.saturating_sub(5)) as f64;
        let now = energy[k];
        let t = (k * hop) as f64 / r;
        if now > 1e-6 && now > before * 8.0 && t - last > 0.05 {
            onsets.push((t * 1000.0).round() / 1000.0);
            last = t;
            if onsets.len() >= 64 {
                break;
            }
        }
    }

    Analysis {
        seconds: frames as f64 / r,
        channels,
        sample_rate: rate,
        peak_db: db(peak),
        rms_db: db(rms),
        lufs,
        max_short_term_lufs: max_st,
        crest_db: (rms > 0.0).then(|| 20.0 * (peak / rms).log10()),
        sound_from,
        sound_to,
        onsets,
        centroid_hz: centroid(samples, ch, r),
        rms_curve_db: curve_db
            .into_iter()
            .map(|d| (d * 10.0).round() / 10.0)
            .collect(),
    }
}

/// Mean spectral centroid of the loudest part, from a few FFT frames.
fn centroid(samples: &[f32], ch: usize, rate: f64) -> Option<f64> {
    use realfft::RealFftPlanner;
    const N: usize = 2048;
    let frames = samples.len() / ch;
    if frames < N {
        return None;
    }
    let fft = RealFftPlanner::<f64>::new().plan_fft_forward(N);
    let mut input = fft.make_input_vec();
    let mut out = fft.make_output_vec();
    let hops = (frames - N) / N + 1;
    let every = hops.div_ceil(32).max(1);
    let (mut num, mut den) = (0f64, 0f64);
    for h in (0..hops).step_by(every) {
        for (i, v) in input.iter_mut().enumerate() {
            let f = h * N + i;
            let mono = (0..ch).map(|c| samples[f * ch + c] as f64).sum::<f64>() / ch as f64;
            let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / N as f64).cos();
            *v = mono * w;
        }
        if fft.process(&mut input, &mut out).is_err() {
            return None;
        }
        for (k, c) in out.iter().enumerate().skip(1) {
            let m = c.norm();
            num += m * k as f64 * rate / N as f64;
            den += m;
        }
    }
    (den > 1e-9).then(|| (num / den).round())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A full-scale 1 kHz sine at 48 kHz, stereo, reads about -3 dBFS RMS
    /// and, per BS.1770's own reference, -3.01 LUFS per channel summed:
    /// stereo is +3 dB, so about 0 LUFS.
    #[test]
    fn a_sine_measures_as_the_standard_says() {
        let rate = 48_000;
        let n = rate as usize * 3;
        let mut s = Vec::with_capacity(n * 2);
        for i in 0..n {
            let x =
                (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / rate as f64).sin() as f32 * 0.5;
            s.push(x);
            s.push(x);
        }
        let a = analyze(&s, 2, rate);
        assert!((a.peak_db.unwrap() + 6.02).abs() < 0.05, "{:?}", a.peak_db);
        assert!((a.rms_db.unwrap() + 9.03).abs() < 0.05, "{:?}", a.rms_db);
        // -6.02 dBFS sine, two channels: -6.02 - 3.01 + 3.01 + K-weight
        // gain at 1 kHz (~0.69 dB) - 0.691 offset = about -6.03 LUFS.
        let l = a.lufs.unwrap();
        assert!((l + 6.03).abs() < 0.2, "{l}");
        assert!(
            (a.centroid_hz.unwrap() - 1000.0).abs() < 60.0,
            "{:?}",
            a.centroid_hz
        );
        assert_eq!(a.sound_from, Some(0.0));
    }

    #[test]
    fn finds_where_the_sound_is_and_the_hit() {
        let rate = 48_000;
        let mut s = vec![0.0f32; rate as usize * 2];
        // Silence, then a hit at 0.5 s decaying over 0.5 s.
        for i in 0..rate as usize / 2 {
            let t = i as f32 / (rate as f32 / 2.0);
            s[rate as usize / 2 + i] = (1.0 - t) * if i % 20 < 10 { 0.8 } else { -0.8 };
        }
        let a = analyze(&s, 1, rate);
        assert!(
            (a.sound_from.unwrap() - 0.5).abs() < 0.11,
            "{:?}",
            a.sound_from
        );
        assert!(a.sound_to.unwrap() <= 1.1, "{:?}", a.sound_to);
        assert_eq!(a.onsets.len(), 1, "{:?}", a.onsets);
        assert!((a.onsets[0] - 0.5).abs() < 0.02);
        assert_eq!(a.rms_curve_db.len(), 20);
        let silent = analyze(&[0.0; 4800], 1, rate);
        assert_eq!((silent.peak_db, silent.lufs), (None, None));
    }
}
