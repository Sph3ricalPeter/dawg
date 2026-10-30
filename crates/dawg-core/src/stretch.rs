//! Offline time-stretch and pitch-shift for clips.
//!
//! A phase vocoder with identity phase locking (Laroche and Dolson) stretches
//! the audio by `stretch × pitch ratio`, then the windowed-sinc resampler
//! reads it back at the pitch ratio, so length and pitch move
//! independently. All channels share one set of phase advances, taken from
//! their sum, so the stereo image holds still. The audio is cut at its
//! onsets and each piece is stretched on its own, starting from its own
//! phases, so a hit never smears back into the silence before it.
//!
//! It runs when a clip's stretch or pitch changes, never on the audio
//! thread: the clip keeps the result (see [`crate::Clip::audio`]) and the
//! renderer reads it like any other source.

use std::f64::consts::PI;

use realfft::num_complex::Complex;
use realfft::RealFftPlanner;

use crate::model::Source;
use crate::resample::resample;

/// Shortest and longest stretch, as timeline frames per source frame.
pub const MIN_STRETCH: f64 = 0.25;
pub const MAX_STRETCH: f64 = 4.0;
/// Pitch range in semitones.
pub const MAX_PITCH: f32 = 24.0;

/// Pitch ratio of `semitones`.
pub fn pitch_ratio(semitones: f32) -> f64 {
    2f64.powf(semitones as f64 / 12.0)
}

/// `source` (at `rate` Hz) played `stretch` times as long and `semitones`
/// higher: frame `j` of the result is source position `j / stretch`. The
/// result has `round(frames × stretch)` frames.
pub fn process(source: &Source, rate: u32, stretch: f64, semitones: f32) -> Source {
    let frames = source.frames() as usize;
    let ch = source.channels() as usize;
    let target = ((frames as f64 * stretch).round() as usize).max(1);
    let ratio = pitch_ratio(semitones);
    let factor = stretch * ratio;
    let stretched = if (factor - 1.0).abs() < 1e-9 {
        source.samples().to_vec()
    } else {
        vocode(source.samples(), ch, factor, fft_size(rate))
    };
    let mut out = if (ratio - 1.0).abs() < 1e-9 {
        stretched
    } else {
        // Read back `ratio` times faster: as a rate change from
        // `ratio × SCALE` to `SCALE` Hz.
        const SCALE: f64 = 192_000.0;
        let from = (ratio * SCALE).round() as u32;
        let to = SCALE as u32;
        let s = Source::new(ch as u16, stretched);
        resample(&s, from, to).samples().to_vec()
    };
    out.resize(target * ch, 0.0);
    Source::new(ch as u16, out).with_id(source.id())
}

/// About 43 ms windows: long enough for bass, short enough for drums.
fn fft_size(rate: u32) -> usize {
    let n = (rate as f64 * 0.043).max(256.0);
    1 << (n.log2().round() as u32)
}

/// `input` (interleaved, `ch` channels) made `factor` times as long at the
/// same pitch, onset to onset.
fn vocode(input: &[f32], ch: usize, factor: f64, n: usize) -> Vec<f32> {
    let frames_in = input.len() / ch;
    let total = (frames_in as f64 * factor).ceil() as usize;
    let mut cuts = onsets(input, ch, n);
    cuts.push(frames_in);
    let mut out = Vec::with_capacity(total * ch);
    for w in cuts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let len = if b == frames_in {
            total
        } else {
            (b as f64 * factor).round() as usize
        } - out.len() / ch;
        out.extend(vocode_piece(&input[a * ch..b * ch], ch, factor, n, len));
    }
    out
}

/// Frames where a hit starts, after 0: where the energy of the signal's
/// slope jumps well above the moments before. At least `gap` apart.
fn onsets(input: &[f32], ch: usize, gap: usize) -> Vec<usize> {
    const BLOCK: usize = 128;
    let frames = input.len() / ch;
    let energy: Vec<f64> = (0..frames / BLOCK)
        .map(|b| {
            let mut e = 0.0;
            for f in (b * BLOCK).max(1)..(b + 1) * BLOCK {
                for c in 0..ch {
                    let d = input[f * ch + c] as f64 - input[(f - 1) * ch + c] as f64;
                    e += d * d;
                }
            }
            e
        })
        .collect();
    let mut out = vec![0];
    for b in 4..energy.len() {
        let before = energy[b - 4..b].iter().copied().fold(0.0, f64::max);
        let at = b * BLOCK - BLOCK / 4;
        if energy[b] > 8.0 * before
            && energy[b] > 1e-5 * BLOCK as f64
            && at >= out.last().unwrap() + gap
            && at + gap <= frames
        {
            out.push(at);
        }
    }
    out
}

/// Phase vocoder: one piece of `input`, made `frames_out` frames long.
fn vocode_piece(input: &[f32], ch: usize, factor: f64, n: usize, frames_out: usize) -> Vec<f32> {
    let frames_in = input.len() / ch;
    let half = n / 2;
    let bins = half + 1;
    // Output hop; the analysis hop is this over `factor`, rounded per frame
    // so the average ratio is exact.
    let hop = n / 4;

    let mut planner = RealFftPlanner::<f64>::new();
    let fwd = planner.plan_fft_forward(n);
    let inv = planner.plan_fft_inverse(n);
    let window: Vec<f64> = (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / n as f64).cos())
        .collect();

    let mut out = vec![0f64; (frames_out + n) * ch];
    let mut norm = vec![0f64; frames_out + n];
    let mut buf = vec![0f64; n];
    let mut spec: Vec<Vec<Complex<f64>>> =
        (0..ch).map(|_| vec![Complex::default(); bins]).collect();
    let mut sum = vec![Complex::<f64>::default(); bins];
    let mut mag = vec![0f64; bins];
    let mut phase = vec![0f64; bins];
    let mut prev_phase = vec![0f64; bins];
    let mut synth = vec![0f64; bins];
    let mut owner = vec![0usize; bins];
    let mut peaks = Vec::with_capacity(bins / 2);
    let mut prev_pos: i64 = 0;

    let mut m = 0usize;
    loop {
        let centre = m * hop;
        if centre > frames_out + half {
            break;
        }
        let pos = (centre as f64 / factor).round() as i64;

        // Windowed analysis around `pos`, per channel.
        for (c, s) in spec.iter_mut().enumerate() {
            for (i, b) in buf.iter_mut().enumerate() {
                let at = pos - half as i64 + i as i64;
                *b = if at >= 0 && (at as usize) < frames_in {
                    input[at as usize * ch + c] as f64 * window[i]
                } else {
                    0.0
                };
            }
            fwd.process(&mut buf, s).expect("fft sizes match");
        }
        for k in 0..bins {
            sum[k] = spec.iter().map(|s| s[k]).sum();
            mag[k] = sum[k].norm();
            phase[k] = sum[k].arg();
        }

        // The piece starts from its own phases, so its first frame is the
        // input as it is.
        if m == 0 {
            synth.copy_from_slice(&phase);
        } else {
            let ha = (pos - prev_pos) as f64;
            // Spectral peaks, and the peak each bin belongs to.
            peaks.clear();
            for k in 1..bins - 1 {
                if mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] {
                    peaks.push(k);
                }
            }
            if peaks.is_empty() {
                peaks.push(0);
            }
            let mut p = 0;
            for (k, o) in owner.iter_mut().enumerate() {
                while p + 1 < peaks.len() && k * 2 > peaks[p] + peaks[p + 1] {
                    p += 1;
                }
                *o = peaks[p];
            }
            let mut next = synth.clone();
            for &k in &peaks {
                let omega = 2.0 * PI * k as f64 / n as f64;
                let advance = if ha > 0.0 {
                    let d = wrap(phase[k] - prev_phase[k] - omega * ha);
                    omega + d / ha
                } else {
                    omega
                };
                next[k] = synth[k] + advance * hop as f64;
            }
            for k in 0..bins {
                let pk = owner[k];
                if pk != k {
                    next[k] = next[pk] + phase[k] - phase[pk];
                }
            }
            synth = next;
        }
        prev_phase.copy_from_slice(&phase);
        prev_pos = pos;

        // Turn every channel by the same amounts and overlap-add.
        let start = centre as i64 - half as i64;
        for (c, s) in spec.iter_mut().enumerate() {
            for k in 0..bins {
                s[k] *= Complex::from_polar(1.0, synth[k] - phase[k]);
            }
            s[0].im = 0.0;
            s[half].im = 0.0;
            inv.process(s, &mut buf).expect("fft sizes match");
            for (i, &v) in buf.iter().enumerate() {
                let at = start + i as i64;
                if at >= 0 {
                    out[at as usize * ch + c] += v * window[i] / n as f64;
                }
            }
        }
        for (i, w) in window.iter().enumerate() {
            let at = start + i as i64;
            if at >= 0 {
                norm[at as usize] += w * w;
            }
        }
        m += 1;
    }

    let floor = 1e-3;
    let mut res = Vec::with_capacity(frames_out * ch);
    for f in 0..frames_out {
        let g = 1.0 / norm[f].max(floor);
        for c in 0..ch {
            res.push((out[f * ch + c] * g) as f32);
        }
    }
    res
}

/// `x` wrapped to -π..π.
fn wrap(x: f64) -> f64 {
    x - 2.0 * PI * (x / (2.0 * PI)).round()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn sine(frames: usize, hz: f64, ch: usize) -> Source {
        let s: Vec<f32> = (0..frames)
            .flat_map(|i| {
                let v = (0.5 * (2.0 * PI * hz * i as f64 / RATE as f64).sin()) as f32;
                std::iter::repeat_n(v, ch)
            })
            .collect();
        Source::new(ch as u16, s)
    }

    /// Frequency of the first channel by counting rising zero crossings
    /// away from the edges.
    fn freq(s: &Source) -> f64 {
        let ch = s.channels() as usize;
        let x: Vec<f32> = s.samples().iter().step_by(ch).copied().collect();
        let (a, b) = (x.len() / 5, x.len() * 4 / 5);
        let ups: Vec<usize> = (a..b).filter(|&i| x[i - 1] < 0.0 && x[i] >= 0.0).collect();
        let (first, last) = (ups[0], *ups.last().unwrap());
        (ups.len() - 1) as f64 * RATE as f64 / (last - first) as f64
    }

    fn rms(s: &Source) -> f64 {
        let x = s.samples();
        let (a, b) = (x.len() / 5, x.len() * 4 / 5);
        (x[a..b].iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / (b - a) as f64).sqrt()
    }

    #[test]
    fn stretch_keeps_pitch_and_level() {
        let src = sine(48_000, 440.0, 2);
        for stretch in [0.5, 1.5, 2.0] {
            let out = process(&src, RATE, stretch, 0.0);
            assert_eq!(out.frames(), (48_000.0 * stretch) as u64);
            assert!(
                (freq(&out) - 440.0).abs() < 2.0,
                "{stretch}: {} Hz",
                freq(&out)
            );
            let level = rms(&out) / rms(&src);
            assert!((0.85..1.15).contains(&level), "{stretch}: level {level}");
        }
    }

    #[test]
    fn pitch_keeps_length() {
        let src = sine(48_000, 440.0, 1);
        for (st, want) in [(12.0, 880.0), (-12.0, 220.0), (7.0, 659.26)] {
            let out = process(&src, RATE, 1.0, st);
            assert_eq!(out.frames(), 48_000);
            assert!(
                (freq(&out) - want).abs() < want * 0.01,
                "{st} st: {} Hz",
                freq(&out)
            );
        }
    }

    #[test]
    fn unchanged_is_a_copy() {
        let src = sine(1000, 440.0, 2);
        assert_eq!(process(&src, RATE, 1.0, 0.0).samples(), src.samples());
    }

    #[test]
    fn stereo_stays_in_phase() {
        let src = sine(24_000, 300.0, 2);
        let out = process(&src, RATE, 1.7, 3.0);
        let s = out.samples();
        let worst = s
            .chunks(2)
            .map(|f| (f[0] - f[1]).abs())
            .fold(0f32, f32::max);
        assert!(worst < 1e-5, "channels drifted apart by {worst}");
    }
}

#[cfg(test)]
mod extremes {
    use super::*;

    #[test]
    fn extremes_stay_finite_and_bounded() {
        let mut x = 1u32;
        let noise: Vec<f32> = (0..20_000)
            .map(|_| {
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((x >> 8) as f32 / (1u32 << 23) as f32 - 1.0) * 0.5
            })
            .collect();
        let src = Source::new(2, noise);
        for (s, p) in [
            (4.0, 24.0),
            (0.25, -24.0),
            (4.0, -24.0),
            (0.25, 24.0),
            (1.0, 0.01),
        ] {
            let out = process(&src, 48_000, s, p);
            assert_eq!(out.frames(), (10_000.0 * s) as u64);
            let peak = out.samples().iter().fold(0f32, |m, v| m.max(v.abs()));
            assert!(peak.is_finite() && peak < 2.0, "{s} × {p} st: peak {peak}");
        }
    }
}
