//! Devices: the processors in a channel's chain, in signal order.
//!
//! Every channel (and the master) owns an ordered chain. A device is plain
//! data, its parameters in real units, so the UI, the CLI and agents read
//! and edit it the same way. The renderer keeps each device's running state
//! (filter memory, a compressor's envelope) by device id, so a new snapshot
//! doesn't reset it.

use serde::{Deserialize, Serialize};

use crate::eq::{Eq, EqBand, MAX_BANDS};

/// Most devices one chain holds; later ones are kept but not heard.
pub const MAX_DEVICES: usize = 16;

/// The kinds of device, for adding one with its default settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Eq,
    Compressor,
    Utility,
}

impl DeviceKind {
    pub fn name(self) -> &'static str {
        match self {
            DeviceKind::Eq => "EQ",
            DeviceKind::Compressor => "Compressor",
            DeviceKind::Utility => "Utility",
        }
    }

    /// Whether the device has a second input ("Input from").
    pub fn has_sidechain(self) -> bool {
        matches!(self, DeviceKind::Compressor)
    }
}

/// A compressor: feed-forward, stereo-linked, soft knee.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CompParams {
    /// dBFS, -60 to 0.
    pub threshold_db: f32,
    /// 1 to 20 (20 is as good as a limiter).
    pub ratio: f32,
    /// ms, 0.05 to 200.
    pub attack_ms: f32,
    /// ms, 5 to 2000.
    pub release_ms: f32,
    /// dB, 0 (hard) to 24.
    pub knee_db: f32,
    /// dB, -12 to 24.
    pub makeup_db: f32,
    /// Wet share, 0 to 1: below 1 is parallel compression.
    pub mix: f32,
}

impl Default for CompParams {
    fn default() -> Self {
        Self {
            threshold_db: -18.0,
            ratio: 3.0,
            attack_ms: 10.0,
            release_ms: 100.0,
            knee_db: 6.0,
            makeup_db: 0.0,
            mix: 1.0,
        }
    }
}

/// Utility: gain, stereo width, mono, phase flips and a DC filter.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UtilityParams {
    /// dB, -48 to 24; -96 is silence.
    pub gain_db: f32,
    /// 0 (mono) to 2; 1 leaves the stereo image alone.
    pub width: f32,
    pub mono: bool,
    pub flip_l: bool,
    pub flip_r: bool,
    /// A 5 Hz high pass that takes out DC offset.
    pub dc: bool,
}

impl Default for UtilityParams {
    fn default() -> Self {
        Self {
            gain_db: 0.0,
            width: 1.0,
            mono: false,
            flip_l: false,
            flip_r: false,
            dc: false,
        }
    }
}

/// A device's settings, tagged by kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeviceParams {
    Eq {
        #[serde(default)]
        bands: Vec<EqBand>,
    },
    Compressor(CompParams),
    Utility(UtilityParams),
}

impl DeviceParams {
    pub fn default_for(kind: DeviceKind) -> Self {
        match kind {
            DeviceKind::Eq => DeviceParams::Eq { bands: Vec::new() },
            DeviceKind::Compressor => DeviceParams::Compressor(CompParams::default()),
            DeviceKind::Utility => DeviceParams::Utility(UtilityParams::default()),
        }
    }

    pub fn kind(&self) -> DeviceKind {
        match self {
            DeviceParams::Eq { .. } => DeviceKind::Eq,
            DeviceParams::Compressor(_) => DeviceKind::Compressor,
            DeviceParams::Utility(_) => DeviceKind::Utility,
        }
    }

    /// The same settings with every value in range.
    pub fn clamped(&self) -> DeviceParams {
        let fin = |v: f32, d: f32| if v.is_finite() { v } else { d };
        match self {
            DeviceParams::Eq { bands } => DeviceParams::Eq {
                bands: bands.iter().take(MAX_BANDS).map(|b| b.clamped()).collect(),
            },
            DeviceParams::Compressor(c) => {
                let d = CompParams::default();
                DeviceParams::Compressor(CompParams {
                    threshold_db: fin(c.threshold_db, d.threshold_db).clamp(-60.0, 0.0),
                    ratio: fin(c.ratio, d.ratio).clamp(1.0, 20.0),
                    attack_ms: fin(c.attack_ms, d.attack_ms).clamp(0.05, 200.0),
                    release_ms: fin(c.release_ms, d.release_ms).clamp(5.0, 2000.0),
                    knee_db: fin(c.knee_db, d.knee_db).clamp(0.0, 24.0),
                    makeup_db: fin(c.makeup_db, d.makeup_db).clamp(-12.0, 24.0),
                    mix: fin(c.mix, d.mix).clamp(0.0, 1.0),
                })
            }
            DeviceParams::Utility(u) => DeviceParams::Utility(UtilityParams {
                gain_db: if fin(u.gain_db, 0.0) <= crate::command::MIN_GAIN_DB {
                    crate::command::MIN_GAIN_DB
                } else {
                    fin(u.gain_db, 0.0).clamp(-48.0, 24.0)
                },
                width: fin(u.width, 1.0).clamp(0.0, 2.0),
                ..*u
            }),
        }
    }
}

/// One device in a chain.
#[derive(Debug, Clone, PartialEq)]
pub struct Device {
    /// Stable id, unique in the project.
    pub id: u64,
    /// Off devices are bypassed, keeping their settings.
    pub on: bool,
    /// For devices with a second input: the channel it listens to.
    pub sidechain: Option<u64>,
    params: DeviceParams,
    /// An EQ's biquads; empty for other kinds.
    eq: Eq,
}

impl Device {
    /// A device of `params` (clamped into range) at `rate` Hz.
    pub fn new(id: u64, params: DeviceParams, rate: u32) -> Device {
        let params = params.clamped();
        let eq = match &params {
            DeviceParams::Eq { bands } => Eq::new(bands, false, rate),
            _ => Eq::default(),
        };
        Device {
            id,
            on: true,
            sidechain: None,
            params,
            eq,
        }
    }

    /// An EQ device of `bands`.
    pub fn eq(id: u64, bands: &[EqBand], rate: u32) -> Device {
        Device::new(
            id,
            DeviceParams::Eq {
                bands: bands.to_vec(),
            },
            rate,
        )
    }

    pub fn kind(&self) -> DeviceKind {
        self.params.kind()
    }

    pub fn params(&self) -> &DeviceParams {
        &self.params
    }

    /// Replaces the settings; the kind can't change.
    pub fn set_params(&mut self, params: DeviceParams, rate: u32) -> bool {
        if params.kind() != self.kind() {
            return false;
        }
        let on = self.on;
        let sc = self.sidechain;
        *self = Device::new(self.id, params, rate);
        self.on = on;
        self.sidechain = sc;
        true
    }

    /// The same device at another rate.
    pub fn at_rate(&self, rate: u32) -> Device {
        Device {
            eq: self.eq.at_rate(rate),
            ..self.clone()
        }
    }

    /// The EQ's filters, for EQ devices.
    pub fn eq_filters(&self) -> &Eq {
        &self.eq
    }

    /// Whether the device changes the sound at all.
    pub fn active(&self) -> bool {
        self.on
            && match &self.params {
                DeviceParams::Eq { .. } => self.eq.active(),
                DeviceParams::Compressor(c) => c.mix > 0.0,
                DeviceParams::Utility(u) => *u != UtilityParams::default(),
            }
    }
}

/// A device as the project file and the UI see it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub id: u64,
    #[serde(default = "yes")]
    pub on: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidechain: Option<u64>,
    #[serde(flatten)]
    pub params: DeviceParams,
}

fn yes() -> bool {
    true
}

impl DeviceEntry {
    pub fn of(d: &Device) -> DeviceEntry {
        DeviceEntry {
            id: d.id,
            on: d.on,
            sidechain: d.sidechain,
            params: d.params.clone(),
        }
    }

    pub fn device(&self, rate: u32) -> Device {
        let mut d = Device::new(self.id, self.params.clone(), rate);
        d.on = self.on;
        d.sidechain = self.sidechain.filter(|_| d.kind().has_sidechain());
        d
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_round_trip_as_flat_json() {
        let mut d = Device::new(
            7,
            DeviceParams::Compressor(CompParams {
                ratio: 4.0,
                ..CompParams::default()
            }),
            48_000,
        );
        d.sidechain = Some(3);
        let json = serde_json::to_value(DeviceEntry::of(&d)).unwrap();
        assert_eq!(json["kind"], "compressor");
        assert_eq!(json["ratio"], 4.0);
        assert_eq!(json["sidechain"], 3);
        let back: DeviceEntry = serde_json::from_value(json).unwrap();
        assert_eq!(back.device(48_000), d);
    }

    #[test]
    fn params_are_clamped_and_kinds_kept() {
        let mut d = Device::new(1, DeviceParams::default_for(DeviceKind::Utility), 48_000);
        assert!(!d.active());
        let wild = DeviceParams::Utility(UtilityParams {
            width: 9.0,
            gain_db: f32::NAN,
            ..UtilityParams::default()
        });
        assert!(d.set_params(wild, 48_000));
        let DeviceParams::Utility(u) = d.params() else {
            panic!()
        };
        assert_eq!((u.width, u.gain_db), (2.0, 0.0));
        assert!(!d.set_params(DeviceParams::default_for(DeviceKind::Eq), 48_000));
    }
}
