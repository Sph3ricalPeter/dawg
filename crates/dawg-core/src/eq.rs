//! The track EQ: a parametric equaliser in the spirit of FabFilter Pro-Q.
//!
//! Each band is a bell, shelf, cut, notch or band pass. Bands become chains
//! of biquads (RBJ cookbook; cuts are Butterworth cascades of 6 to 48 dB per
//! octave) when the EQ is set, off the audio thread. The renderer runs them
//! per track before the track's volume and pan, with state it allocated up
//! front, so playback and export hear the same EQ.

use std::f64::consts::PI;

use serde::{Deserialize, Serialize};

/// Most bands a track's EQ holds.
pub const MAX_BANDS: usize = 12;
/// Biquads one band can need: a 48 dB/oct cut.
pub const SECTIONS_PER_BAND: usize = 4;
/// Biquads one track's EQ can need.
pub const MAX_SECTIONS: usize = MAX_BANDS * SECTIONS_PER_BAND;

pub const MIN_FREQ: f32 = 10.0;
pub const MAX_FREQ: f32 = 30_000.0;
pub const MAX_GAIN_DB: f32 = 30.0;
pub const MIN_Q: f32 = 0.025;
pub const MAX_Q: f32 = 40.0;
/// Cut slopes in dB per octave.
pub const SLOPES: [u8; 6] = [6, 12, 18, 24, 36, 48];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BandKind {
    Bell,
    LowShelf,
    HighShelf,
    LowCut,
    HighCut,
    Notch,
    BandPass,
}

/// One EQ band.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqBand {
    pub kind: BandKind,
    /// Centre or corner frequency in Hz.
    pub freq: f32,
    /// Bells and shelves only.
    #[serde(default)]
    pub gain_db: f32,
    /// Width of bells, notches and band passes; resonance of cuts and
    /// shelves (0.71 is flat).
    #[serde(default = "default_q")]
    pub q: f32,
    /// Cuts only: dB per octave, one of [`SLOPES`].
    #[serde(default = "default_slope")]
    pub slope: u8,
    /// Off bands are kept but not heard.
    #[serde(default = "default_on")]
    pub on: bool,
}

fn default_q() -> f32 {
    std::f32::consts::FRAC_1_SQRT_2
}
fn default_slope() -> u8 {
    12
}
fn default_on() -> bool {
    true
}

impl EqBand {
    /// The band with every value in range.
    pub fn clamped(self) -> EqBand {
        let fin = |v: f32, d: f32| if v.is_finite() { v } else { d };
        let slope = *SLOPES
            .iter()
            .min_by_key(|s| (**s as i32 - self.slope as i32).abs())
            .unwrap_or(&12);
        EqBand {
            freq: fin(self.freq, 1000.0).clamp(MIN_FREQ, MAX_FREQ),
            gain_db: fin(self.gain_db, 0.0).clamp(-MAX_GAIN_DB, MAX_GAIN_DB),
            q: fin(self.q, default_q()).clamp(MIN_Q, MAX_Q),
            slope,
            ..self
        }
    }

    /// The band's biquads at `rate` Hz.
    fn sections(&self, rate: u32, out: &mut Vec<Biquad>) {
        let nyq = rate as f64 / 2.0;
        // Keep the corner clear of Nyquist, where the bilinear transform
        // folds up.
        let f = (self.freq as f64).min(nyq * 0.98);
        let w0 = 2.0 * PI * f / rate as f64;
        let q = self.q as f64;
        let g = self.gain_db as f64;
        match self.kind {
            BandKind::Bell => out.push(Biquad::bell(w0, q, g)),
            BandKind::LowShelf => out.push(Biquad::shelf(w0, q, g, false)),
            BandKind::HighShelf => out.push(Biquad::shelf(w0, q, g, true)),
            BandKind::Notch => out.push(Biquad::notch(w0, q)),
            BandKind::BandPass => out.push(Biquad::band_pass(w0, q)),
            BandKind::LowCut | BandKind::HighCut => {
                let high = self.kind == BandKind::LowCut;
                let order = (self.slope / 6).max(1) as usize;
                if order % 2 == 1 {
                    out.push(Biquad::first_order(w0, high));
                }
                // Butterworth pole pairs; the sharpest takes the resonance.
                let pairs = order / 2;
                for k in 0..pairs {
                    let theta = PI * (2 * k + 1) as f64 / (2 * order) as f64;
                    let mut qk = 1.0 / (2.0 * theta.sin());
                    if k == 0 {
                        qk *= q / std::f64::consts::FRAC_1_SQRT_2;
                    }
                    out.push(if high {
                        Biquad::high_pass(w0, qk)
                    } else {
                        Biquad::low_pass(w0, qk)
                    });
                }
            }
        }
    }
}

/// One second-order section, normalised so `a0` is 1. A first-order section
/// has `b2` and `a2` at 0.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
pub struct Biquad {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Biquad {
    fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Biquad {
        Biquad {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    fn bell(w0: f64, q: f64, db: f64) -> Biquad {
        let a = 10f64.powf(db / 40.0);
        let alpha = w0.sin() / (2.0 * q);
        let c = w0.cos();
        Self::norm(
            1.0 + alpha * a,
            -2.0 * c,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * c,
            1.0 - alpha / a,
        )
    }

    fn shelf(w0: f64, q: f64, db: f64, high: bool) -> Biquad {
        let a = 10f64.powf(db / 40.0);
        let alpha = w0.sin() / (2.0 * q);
        let c = w0.cos();
        let s = 2.0 * a.sqrt() * alpha;
        if high {
            Self::norm(
                a * ((a + 1.0) + (a - 1.0) * c + s),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
                a * ((a + 1.0) + (a - 1.0) * c - s),
                (a + 1.0) - (a - 1.0) * c + s,
                2.0 * ((a - 1.0) - (a + 1.0) * c),
                (a + 1.0) - (a - 1.0) * c - s,
            )
        } else {
            Self::norm(
                a * ((a + 1.0) - (a - 1.0) * c + s),
                2.0 * a * ((a - 1.0) - (a + 1.0) * c),
                a * ((a + 1.0) - (a - 1.0) * c - s),
                (a + 1.0) + (a - 1.0) * c + s,
                -2.0 * ((a - 1.0) + (a + 1.0) * c),
                (a + 1.0) + (a - 1.0) * c - s,
            )
        }
    }

    fn notch(w0: f64, q: f64) -> Biquad {
        let alpha = w0.sin() / (2.0 * q);
        let c = w0.cos();
        Self::norm(1.0, -2.0 * c, 1.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    fn band_pass(w0: f64, q: f64) -> Biquad {
        let alpha = w0.sin() / (2.0 * q);
        let c = w0.cos();
        Self::norm(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    fn low_pass(w0: f64, q: f64) -> Biquad {
        let alpha = w0.sin() / (2.0 * q);
        let c = w0.cos();
        Self::norm(
            (1.0 - c) / 2.0,
            1.0 - c,
            (1.0 - c) / 2.0,
            1.0 + alpha,
            -2.0 * c,
            1.0 - alpha,
        )
    }

    fn high_pass(w0: f64, q: f64) -> Biquad {
        let alpha = w0.sin() / (2.0 * q);
        let c = w0.cos();
        Self::norm(
            (1.0 + c) / 2.0,
            -(1.0 + c),
            (1.0 + c) / 2.0,
            1.0 + alpha,
            -2.0 * c,
            1.0 - alpha,
        )
    }

    fn first_order(w0: f64, high: bool) -> Biquad {
        let k = (w0 / 2.0).tan();
        if high {
            Self::norm(1.0, -1.0, 0.0, 1.0 + k, k - 1.0, 0.0)
        } else {
            Self::norm(k, k, 0.0, 1.0 + k, k - 1.0, 0.0)
        }
    }

    /// Gain at angular frequency `w` (radians per sample).
    pub fn magnitude(&self, w: f64) -> f64 {
        let (c1, s1) = (w.cos(), w.sin());
        let (c2, s2) = ((2.0 * w).cos(), (2.0 * w).sin());
        let nr = self.b0 + self.b1 * c1 + self.b2 * c2;
        let ni = -(self.b1 * s1 + self.b2 * s2);
        let dr = 1.0 + self.a1 * c1 + self.a2 * c2;
        let di = -(self.a1 * s1 + self.a2 * s2);
        ((nr * nr + ni * ni) / (dr * dr + di * di)).sqrt()
    }

    /// Runs one sample through the section; `z` is its transposed direct
    /// form II state.
    #[inline]
    pub(crate) fn tick(&self, x: f64, z: &mut [f64; 2]) -> f64 {
        let y = self.b0 * x + z[0];
        z[0] = self.b1 * x - self.a1 * y + z[1];
        z[1] = self.b2 * x - self.a2 * y;
        y
    }
}

/// A track's EQ: its bands as set, and the biquads they make.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Eq {
    bands: Vec<EqBand>,
    /// The whole EQ is off; the bands are kept.
    bypass: bool,
    /// Sections by slot: band `b` uses slots `b * SECTIONS_PER_BAND ..`,
    /// so a band's filter state stays put while others change. Unused slots
    /// are `None`.
    sections: Vec<Option<Biquad>>,
    /// Rate the sections were made for.
    rate: u32,
}

impl Eq {
    /// An EQ of `bands` (at most [`MAX_BANDS`], clamped into range) at
    /// `rate` Hz.
    pub fn new(bands: &[EqBand], bypass: bool, rate: u32) -> Eq {
        let bands: Vec<EqBand> = bands.iter().take(MAX_BANDS).map(|b| b.clamped()).collect();
        let mut sections = vec![None; bands.len() * SECTIONS_PER_BAND];
        let mut tmp = Vec::with_capacity(SECTIONS_PER_BAND);
        for (i, b) in bands.iter().enumerate() {
            if !b.on || bypass {
                continue;
            }
            tmp.clear();
            b.sections(rate, &mut tmp);
            for (j, s) in tmp.iter().enumerate() {
                sections[i * SECTIONS_PER_BAND + j] = Some(*s);
            }
        }
        // Drop the trailing empties so an EQ of off bands costs nothing.
        while sections.last().is_some_and(|s| s.is_none()) {
            sections.pop();
        }
        Eq {
            bands,
            bypass,
            sections,
            rate,
        }
    }

    pub fn bands(&self) -> &[EqBand] {
        &self.bands
    }

    pub fn bypass(&self) -> bool {
        self.bypass
    }

    /// The same EQ at another rate.
    pub fn at_rate(&self, rate: u32) -> Eq {
        if rate == self.rate {
            return self.clone();
        }
        Eq::new(&self.bands, self.bypass, rate)
    }

    /// Whether the EQ changes the sound at all.
    #[inline]
    pub fn active(&self) -> bool {
        !self.sections.is_empty()
    }

    /// Biquads by slot, for the renderer.
    #[inline]
    pub(crate) fn sections(&self) -> &[Option<Biquad>] {
        &self.sections
    }

    /// Gain in dB of the whole EQ at `hz`.
    pub fn response_db(&self, hz: f64) -> f64 {
        let w = 2.0 * PI * hz / self.rate.max(1) as f64;
        let g: f64 = self
            .sections
            .iter()
            .flatten()
            .map(|s| s.magnitude(w))
            .product();
        20.0 * g.max(1e-12).log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn band(kind: BandKind, freq: f32, gain_db: f32) -> EqBand {
        EqBand {
            kind,
            freq,
            gain_db,
            q: default_q(),
            slope: 12,
            on: true,
        }
    }

    #[test]
    fn bell_peaks_at_its_gain() {
        let eq = Eq::new(&[band(BandKind::Bell, 1000.0, 6.0)], false, 48_000);
        assert!((eq.response_db(1000.0) - 6.0).abs() < 0.01);
        assert!(eq.response_db(20.0).abs() < 0.1);
        assert!(eq.response_db(15_000.0).abs() < 0.2);
    }

    #[test]
    fn cuts_fall_at_their_slope() {
        for slope in SLOPES {
            let mut b = band(BandKind::LowCut, 1000.0, 0.0);
            b.slope = slope;
            let eq = Eq::new(&[b], false, 48_000);
            assert!(
                (eq.response_db(1000.0) + 3.0).abs() < 0.3,
                "{slope}: corner"
            );
            // Two octaves below the corner, close to the asymptote.
            let drop = eq.response_db(125.0) - eq.response_db(250.0);
            assert!(
                (drop + slope as f64).abs() < 1.5,
                "{slope}: {drop} dB per octave"
            );
            assert!(eq.response_db(12_000.0).abs() < 0.1);
        }
    }

    #[test]
    fn shelves_reach_their_gain() {
        let lo = Eq::new(&[band(BandKind::LowShelf, 200.0, -9.0)], false, 48_000);
        assert!((lo.response_db(20.0) + 9.0).abs() < 0.2);
        assert!(lo.response_db(10_000.0).abs() < 0.1);
        let hi = Eq::new(&[band(BandKind::HighShelf, 4000.0, 4.0)], false, 48_000);
        assert!((hi.response_db(20_000.0) - 4.0).abs() < 0.3);
    }

    #[test]
    fn off_bands_and_bypass_cost_nothing() {
        let mut b = band(BandKind::Bell, 1000.0, 6.0);
        b.on = false;
        assert!(!Eq::new(&[b], false, 48_000).active());
        assert!(!Eq::new(&[band(BandKind::Bell, 1000.0, 6.0)], true, 48_000).active());
        assert_eq!(Eq::new(&[b], false, 48_000).bands().len(), 1);
    }

    #[test]
    fn values_are_clamped() {
        let wild = EqBand {
            kind: BandKind::LowCut,
            freq: f32::NAN,
            gain_db: 99.0,
            q: 0.0,
            slope: 30,
            on: true,
        }
        .clamped();
        assert_eq!(wild.freq, 1000.0);
        assert_eq!(wild.gain_db, MAX_GAIN_DB);
        assert_eq!(wild.q, MIN_Q);
        assert!(SLOPES.contains(&wild.slope));
    }
}
