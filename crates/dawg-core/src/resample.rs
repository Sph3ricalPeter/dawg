//! Offline sample-rate conversion for files added to a project at another
//! rate. Windowed sinc, band-limited to the lower of the two rates, so a 48
//! kHz file mixes correctly into a 44.1 kHz project and the other way round.
//!
//! It runs once, when a file is added; playback and export never resample
//! (the player's own interpolator only adapts to the device).

use crate::model::Source;

/// Zero crossings of the sinc on each side of the centre.
const HALF: usize = 24;
/// Table entries per zero crossing.
const RES: usize = 512;
/// Passband edge as a fraction of the lower Nyquist rate.
const PASS: f64 = 0.95;

/// `source` (at `from` Hz) converted to `to` Hz.
pub fn resample(source: &Source, from: u32, to: u32) -> Source {
    if from == to || source.frames() == 0 {
        return source.clone();
    }
    let ch = source.channels() as usize;
    let input = source.samples();
    let frames_in = source.frames() as usize;
    let (from, to) = (from as u64, to as u64);
    let frames_out = (frames_in as u64 * to).div_ceil(from) as usize;

    // Cutoff relative to the input rate's Nyquist.
    let fc = PASS * (to as f64 / from as f64).min(1.0);
    let table = kernel();
    // Input frames each side that the kernel reaches.
    let reach = (HALF as f64 / fc).ceil() as i64;

    let mut out = vec![0f32; frames_out * ch];
    let mut acc = vec![0f64; ch];
    for j in 0..frames_out {
        // Input position of output frame j, as whole frames plus a fraction.
        let num = j as u64 * from;
        let base = (num / to) as i64;
        let frac = (num % to) as f64 / to as f64;
        acc.fill(0.0);
        let lo = (base - reach + 1).max(0);
        let hi = (base + reach).min(frames_in as i64 - 1);
        for i in lo..=hi {
            let d = ((i - base) as f64 - frac).abs() * fc;
            if d >= HALF as f64 {
                continue;
            }
            let w = lookup(&table, d) * fc;
            let at = i as usize * ch;
            for (a, x) in acc.iter_mut().zip(&input[at..at + ch]) {
                *a += *x as f64 * w;
            }
        }
        for (o, a) in out[j * ch..(j + 1) * ch].iter_mut().zip(&acc) {
            *o = *a as f32;
        }
    }
    Source::new(source.channels(), out).with_id(source.id())
}

/// The windowed sinc from 0 to `HALF` zero crossings.
fn kernel() -> Vec<f64> {
    use std::f64::consts::PI;
    (0..=HALF * RES + 1)
        .map(|k| {
            let x = k as f64 / RES as f64;
            let sinc = if k == 0 {
                1.0
            } else {
                (PI * x).sin() / (PI * x)
            };
            // Blackman-Harris, centred on 0 and reaching zero at HALF.
            let t = 0.5 + 0.5 * (x / HALF as f64).min(1.0);
            let a = 2.0 * PI * t;
            let w =
                0.35875 - 0.48829 * a.cos() + 0.14128 * (2.0 * a).cos() - 0.01168 * (3.0 * a).cos();
            sinc * w
        })
        .collect()
}

fn lookup(table: &[f64], d: f64) -> f64 {
    let p = d * RES as f64;
    let k = p as usize;
    let t = p - k as f64;
    table[k] + (table[k + 1] - table[k]) * t
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sine sampled exactly at `rate` (tests may use `sin`: they compare
    /// with a tolerance, not a golden file).
    fn sine(freq: f64, rate: u32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| {
                (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() as f32 * 0.5
            })
            .collect()
    }

    #[test]
    fn converts_a_sine_without_changing_it() {
        for (from, to) in [(44_100, 48_000), (48_000, 44_100), (96_000, 44_100)] {
            let src = Source::new(1, sine(1000.0, from, from as usize / 10));
            let out = resample(&src, from, to);
            assert_eq!(
                out.frames(),
                (src.frames() * to as u64).div_ceil(from as u64)
            );
            let want = sine(1000.0, to, out.frames() as usize);
            // Away from the edges, where the kernel runs out of input.
            let worst = (200..out.frames() as usize - 200)
                .map(|i| (out.samples()[i] - want[i]).abs())
                .fold(0f32, f32::max);
            assert!(worst < 1e-3, "{from} -> {to}: off by {worst}");
        }
    }

    #[test]
    fn removes_what_the_new_rate_cannot_hold() {
        // 20 kHz is fine at 48 kHz and must go when converting to 32 kHz.
        let src = Source::new(1, sine(20_000.0, 48_000, 9600));
        let out = resample(&src, 48_000, 32_000);
        let rms = (out.samples()[500..5900].iter().map(|x| x * x).sum::<f32>() / 5400.0).sqrt();
        assert!(rms < 0.01, "alias left at rms {rms}");
    }

    #[test]
    fn keeps_channels_and_id() {
        let src = Source::new(2, vec![0.25; 2000]).with_id(7);
        let out = resample(&src, 22_050, 44_100);
        assert_eq!((out.channels(), out.id(), out.frames()), (2, 7, 2000));
        assert!((out.samples()[1000] - 0.25).abs() < 1e-3);
    }
}
