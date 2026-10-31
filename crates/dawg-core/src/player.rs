//! The playback side of the audio callback, without the device.
//!
//! The app's output stream calls [`Player::fill`]; everything else talks to
//! it through a [`PlayerHandle`] over lock-free rings. Snapshots the player
//! lets go of travel back on a second ring and are freed by the handle's
//! thread, never the audio thread.
//!
//! The project plays at its own rate. When the device runs at another one,
//! a 4-point Hermite interpolator converts on the fly. That is for listening
//! only: export never resamples.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use realfft::RealFftPlanner;
use rtrb::{Consumer, Producer, RingBuffer};

use crate::model::Project;
use crate::render::{Renderer, METER_TRACKS, NO_TAP, OUT_CHANNELS};

/// Frames rendered per block.
const BLOCK: usize = 256;
/// Messages in flight; also bounds the snapshots awaiting release.
const RING: usize = 64;

pub enum PlayerMsg {
    Project(Arc<Project>),
    /// Play timeline frames `from..to`, then stop, or with `looping` jump
    /// back to `loop_from` and carry on until stopped.
    Play {
        from: u64,
        to: u64,
        looping: Option<u64>,
    },
    Stop,
}

pub struct PlayerShared {
    playing: AtomicBool,
    position: AtomicU64,
    /// Peak level per track and side since the last read, as `f32` bits.
    /// Non-negative floats order like their bits, so `fetch_max` works.
    peaks: [[AtomicU32; 2]; METER_TRACKS],
    /// The same for the master output, after the master volume.
    master: [AtomicU32; 2],
    /// The track the analyser listens to, or [`NO_TAP`].
    tap_track: AtomicU64,
}

impl Default for PlayerShared {
    fn default() -> Self {
        Self {
            playing: AtomicBool::new(false),
            position: AtomicU64::new(0),
            tap_track: AtomicU64::new(NO_TAP),
            peaks: std::array::from_fn(|_| [AtomicU32::new(0), AtomicU32::new(0)]),
            master: [AtomicU32::new(0), AtomicU32::new(0)],
        }
    }
}

/// The control side. Not real-time; lives with the app state.
pub struct PlayerHandle {
    tx: Producer<PlayerMsg>,
    garbage: Consumer<Arc<Project>>,
    shared: Arc<PlayerShared>,
    analyser: Analyser,
}

/// FFT size of the analyser: about 6 Hz per bin at 48 kHz.
const ANALYSER_FFT: usize = 8192;
/// Points of a spectrum, log-spaced.
pub const SPECTRUM_POINTS: usize = 256;
/// Lowest frequency of a spectrum.
pub const SPECTRUM_FROM_HZ: f64 = 10.0;

/// The handle's side of the analyser: the tapped track's latest samples.
struct Analyser {
    rx: Consumer<f32>,
    /// The last `ANALYSER_FFT` samples, oldest first.
    hist: Vec<f32>,
    /// Samples taken since the last spectrum.
    fresh: usize,
    window: Vec<f64>,
}

/// One track's spectrum after its EQ: `db[i]` is the level at
/// `from_hz × (to_hz / from_hz)^(i / (len − 1))`, in dBFS for a sine.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spectrum {
    pub from_hz: f64,
    pub to_hz: f64,
    pub db: Vec<f32>,
}

impl PlayerHandle {
    /// Sends `msg`. Returns false if the player stopped taking messages.
    pub fn send(&mut self, msg: PlayerMsg) -> bool {
        self.collect();
        if let PlayerMsg::Play { from, .. } = msg {
            // Report the new position straight away, before the callback
            // picks it up.
            self.shared.position.store(from, Ordering::Relaxed);
            self.shared.playing.store(true, Ordering::Relaxed);
        }
        if let PlayerMsg::Stop = msg {
            self.shared.playing.store(false, Ordering::Relaxed);
        }
        self.tx.push(msg).is_ok()
    }

    /// Frees snapshots the player is done with.
    pub fn collect(&mut self) {
        while self.garbage.pop().is_ok() {}
    }

    pub fn playing(&self) -> bool {
        self.shared.playing.load(Ordering::Relaxed)
    }

    /// Timeline frame being heard (give or take the device buffer).
    pub fn position(&self) -> u64 {
        self.shared.position.load(Ordering::Relaxed)
    }

    /// Peak level (linear, left and right) of each of the first `tracks`
    /// tracks since the last call, which resets them.
    /// The spectrum of `track` after its EQ, from what played since the last
    /// call, or `None` when nothing new played. Starts listening to that
    /// track; `None` stops listening.
    pub fn spectrum(&mut self, track: Option<u64>, rate: u32) -> Option<Spectrum> {
        self.shared
            .tap_track
            .store(track.unwrap_or(NO_TAP), Ordering::Relaxed);
        let a = &mut self.analyser;
        let mut n = 0;
        while let Ok(x) = a.rx.pop() {
            a.hist.push(x);
            n += 1;
        }
        if a.hist.len() > ANALYSER_FFT {
            a.hist.drain(..a.hist.len() - ANALYSER_FFT);
        }
        a.fresh += n;
        if track.is_none() || a.fresh == 0 {
            return None;
        }
        a.fresh = 0;
        let mut buf = vec![0f64; ANALYSER_FFT];
        let pad = ANALYSER_FFT - a.hist.len();
        for (i, &x) in a.hist.iter().enumerate() {
            buf[pad + i] = x as f64 * a.window[pad + i];
        }
        let fft = RealFftPlanner::<f64>::new().plan_fft_forward(ANALYSER_FFT);
        let mut spec = fft.make_output_vec();
        fft.process(&mut buf, &mut spec).ok()?;
        // A full-scale sine reads 0 dB.
        let scale = 2.0 / a.window.iter().sum::<f64>();
        let mags: Vec<f64> = spec.iter().map(|c| c.norm() * scale).collect();
        let bin_hz = rate as f64 / ANALYSER_FFT as f64;
        let to_hz = rate as f64 / 2.0;
        let ratio = to_hz / SPECTRUM_FROM_HZ;
        let mut db = Vec::with_capacity(SPECTRUM_POINTS);
        for i in 0..SPECTRUM_POINTS {
            let at = |k: f64| SPECTRUM_FROM_HZ * ratio.powf(k / (SPECTRUM_POINTS - 1) as f64);
            let (lo, hi) = (at(i as f64 - 0.5) / bin_hz, at(i as f64 + 0.5) / bin_hz);
            // Where a point spans several bins, the loudest; where it falls
            // between two, a blend of them.
            let m = if hi - lo >= 1.0 {
                let (a, b) = (
                    lo.ceil() as usize,
                    (hi.floor() as usize).min(mags.len() - 1),
                );
                mags[a.min(b)..=b].iter().copied().fold(0.0, f64::max)
            } else {
                let x = (at(i as f64) / bin_hz).min((mags.len() - 2) as f64);
                let k = x.floor() as usize;
                mags[k] + (mags[k + 1] - mags[k]) * (x - k as f64)
            };
            db.push((20.0 * m.max(1e-9).log10()) as f32);
        }
        Some(Spectrum {
            from_hz: SPECTRUM_FROM_HZ,
            to_hz,
            db,
        })
    }

    /// The master output's peak level (left, right) since the last call.
    pub fn take_master_peak(&self) -> [f32; 2] {
        self.shared
            .master
            .each_ref()
            .map(|a| f32::from_bits(a.swap(0, Ordering::Relaxed)))
    }

    pub fn take_peaks(&self, tracks: usize) -> Vec<[f32; 2]> {
        self.shared.peaks[..tracks.min(METER_TRACKS)]
            .iter()
            .map(|p| {
                p.each_ref()
                    .map(|a| f32::from_bits(a.swap(0, Ordering::Relaxed)))
            })
            .collect()
    }
}

/// The audio-thread side.
pub struct Player {
    rx: Consumer<PlayerMsg>,
    garbage: Producer<Arc<Project>>,
    shared: Arc<PlayerShared>,
    renderer: Renderer,
    channels: usize,
    device_rate: f64,
    playing: bool,
    stop_at: u64,
    /// Where playback jumps back to at `stop_at`; `None` stops there.
    loop_from: Option<u64>,
    block: Box<[f32]>,
    block_pos: usize,
    block_len: usize,
    /// Source frames `x[-1]`, `x[0]`, `x[1]`, `x[2]` around the read point.
    hist: [[f32; 2]; 4],
    frac: f64,
    /// Timeline frame of `hist[1]`, the one being heard.
    heard: u64,
    /// Source frames per device frame. At 1.0 the interpolator reads `x[0]`
    /// exactly, so same-rate playback is the render, bit for bit.
    step: f64,
}

/// A player for a device running at `device_rate` with `channels`
/// interleaved channels.
pub fn player(project: Arc<Project>, device_rate: u32, channels: usize) -> (Player, PlayerHandle) {
    let (tx, rx) = RingBuffer::new(RING);
    // Room for one released snapshot per message, and then some.
    let (gtx, grx) = RingBuffer::new(RING * 2);
    let shared = Arc::new(PlayerShared::default());
    let step = project.sample_rate as f64 / device_rate as f64;
    let (tap_tx, tap_rx) = RingBuffer::new(ANALYSER_FFT * 4);
    let mut renderer = Renderer::new(project, 0);
    renderer.set_tap(tap_tx);
    let player = Player {
        rx,
        garbage: gtx,
        shared: shared.clone(),
        renderer,
        channels: channels.max(1),
        device_rate: device_rate as f64,
        playing: false,
        stop_at: 0,
        loop_from: None,
        block: vec![0.0; BLOCK * OUT_CHANNELS].into_boxed_slice(),
        block_pos: 0,
        block_len: 0,
        hist: [[0.0; 2]; 4],
        frac: 0.0,
        heard: 0,
        step,
    };
    let handle = PlayerHandle {
        tx,
        garbage: grx,
        shared,
        analyser: Analyser {
            rx: tap_rx,
            hist: Vec::with_capacity(ANALYSER_FFT * 2),
            fresh: 0,
            window: (0..ANALYSER_FFT)
                .map(|i| {
                    0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / ANALYSER_FFT as f64).cos()
                })
                .collect(),
        },
    };
    (player, handle)
}

impl Player {
    /// Fills one device buffer (interleaved, `channels` wide). Real-time
    /// safe: no allocation, locking or freeing.
    pub fn fill(&mut self, out: &mut [f32]) {
        self.handle_messages();
        let ch = self.channels;
        if !self.playing {
            out.fill(0.0);
            return;
        }
        for frame in out.chunks_exact_mut(ch) {
            if self.heard >= self.stop_at {
                self.playing = false;
            }
            let [l, r] = if self.playing {
                self.interpolated()
            } else {
                [0.0; 2]
            };
            match ch {
                1 => frame[0] = 0.5 * (l + r),
                _ => {
                    frame[0] = l;
                    frame[1] = r;
                    frame[2..].fill(0.0);
                }
            }
        }
        if !self.playing {
            self.shared.playing.store(false, Ordering::Relaxed);
        }
        self.shared.position.store(self.heard, Ordering::Relaxed);
    }

    fn handle_messages(&mut self) {
        while let Ok(msg) = self.rx.pop() {
            match msg {
                PlayerMsg::Project(p) => {
                    self.step = p.sample_rate as f64 / self.device_rate;
                    let old = self.renderer.swap_project(p);
                    if let Err(rtrb::PushError::Full(old)) = self.garbage.push(old) {
                        // Never free on this thread; a leak is the lesser evil
                        // and can't happen while the handle keeps collecting.
                        std::mem::forget(old);
                    }
                }
                PlayerMsg::Play { from, to, looping } => {
                    self.renderer.seek(from);
                    self.block_pos = 0;
                    self.block_len = 0;
                    self.stop_at = to;
                    self.loop_from = looping.filter(|&l| l < to);
                    self.playing = true;
                    self.heard = from;
                    self.frac = 0.0;
                    let a = self.next_src();
                    let b = self.next_src();
                    let c = self.next_src();
                    self.hist = [[0.0; 2], a, b, c];
                }
                PlayerMsg::Stop => self.playing = false,
            }
        }
    }

    /// Timeline frame of the next source frame to be read.
    fn src_pos(&self) -> u64 {
        self.renderer.position() - (self.block_len - self.block_pos) as u64
    }

    /// The next rendered frame; silence past the stop point, or the loop's
    /// start again when looping.
    fn next_src(&mut self) -> [f32; 2] {
        if self.src_pos() >= self.stop_at {
            let Some(back) = self.loop_from else {
                return [0.0; 2];
            };
            self.renderer.seek(back);
            self.block_pos = 0;
            self.block_len = 0;
        }
        if self.block_pos == self.block_len {
            self.renderer
                .tap_track(self.shared.tap_track.load(Ordering::Relaxed));
            self.renderer.process(&mut self.block);
            for (shared, peak) in self.shared.peaks.iter().zip(self.renderer.take_peaks()) {
                shared[0].fetch_max(peak[0].to_bits(), Ordering::Relaxed);
                shared[1].fetch_max(peak[1].to_bits(), Ordering::Relaxed);
            }
            let (mut ml, mut mr) = (0.0f32, 0.0f32);
            for f in self.block.as_chunks::<OUT_CHANNELS>().0 {
                ml = ml.max(f[0].abs());
                mr = mr.max(f[1].abs());
            }
            self.shared.master[0].fetch_max(ml.to_bits(), Ordering::Relaxed);
            self.shared.master[1].fetch_max(mr.to_bits(), Ordering::Relaxed);
            self.block_pos = 0;
            self.block_len = BLOCK;
        }
        let i = self.block_pos * OUT_CHANNELS;
        self.block_pos += 1;
        [self.block[i], self.block[i + 1]]
    }

    fn interpolated(&mut self) -> [f32; 2] {
        let t = self.frac as f32;
        let h = &self.hist;
        let mut y = [0.0; 2];
        for (c, y) in y.iter_mut().enumerate() {
            let (xm, x0, x1, x2) = (h[0][c], h[1][c], h[2][c], h[3][c]);
            let c1 = 0.5 * (x1 - xm);
            let c2 = xm - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
            let c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
            *y = ((c3 * t + c2) * t + c1) * t + x0;
        }
        self.frac += self.step;
        while self.frac >= 1.0 {
            self.frac -= 1.0;
            let next = self.next_src();
            self.hist = [self.hist[1], self.hist[2], self.hist[3], next];
            self.heard += 1;
            if let Some(back) = self.loop_from {
                if self.heard >= self.stop_at {
                    self.heard = back + (self.heard - self.stop_at);
                }
            }
        }
        y
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Clip, Source, Track};

    fn project(rate: u32, frames: usize) -> Arc<Project> {
        let samples: Vec<f32> = (0..frames).map(|i| (i % 50) as f32 / 100.0).collect();
        Arc::new(Project::with_tracks(
            rate,
            vec![Track {
                clips: vec![Clip::new(Arc::new(Source::new(1, samples)), 0)],
                ..Track::default()
            }],
        ))
    }

    #[test]
    fn same_rate_playback_is_the_render() {
        let p = project(48_000, 3000);
        let (mut player, mut handle) = player(p.clone(), 48_000, 2);
        handle.send(PlayerMsg::Play {
            from: 100,
            to: 2000,
            looping: None,
        });
        let mut out = vec![0.0; 2 * 4000];
        for chunk in out.chunks_mut(2 * 480) {
            player.fill(chunk);
        }
        let want = crate::render(p, 100, 1900);
        assert_eq!(&out[..want.len()], &want[..]);
        assert!(out[want.len()..].iter().all(|&s| s == 0.0));
        assert!(!handle.playing());
        assert_eq!(handle.position(), 2000);
    }

    #[test]
    fn loops_back_until_stopped() {
        let p = project(48_000, 3000);
        let (mut player, mut handle) = player(p.clone(), 48_000, 2);
        handle.send(PlayerMsg::Play {
            from: 1500,
            to: 2000,
            looping: Some(0),
        });
        let mut out = vec![0.0; 2 * 2500];
        for chunk in out.chunks_mut(2 * 480) {
            player.fill(chunk);
        }
        // 500 frames to the loop end, then 0..2000 from the top.
        let mut want = crate::render(p.clone(), 1500, 500);
        want.extend(crate::render(p, 0, 2000));
        assert_eq!(out, want);
        assert!(handle.playing());
        // Exactly at the loop end again, so back at its start.
        assert_eq!(handle.position(), 0);
        handle.send(PlayerMsg::Stop);
        player.fill(&mut out[..8]);
        assert!(!handle.playing());
    }

    #[test]
    fn meters_each_track_after_its_volume_and_pan() {
        // Peak sample 0.49; one track at half volume panned hard left, one muted.
        let samples: Vec<f32> = (0..3000).map(|i| (i % 50) as f32 / 100.0).collect();
        let src = Arc::new(Source::new(1, samples));
        let p = Arc::new(Project::with_tracks(
            48_000,
            vec![
                Track {
                    clips: vec![Clip::new(src.clone(), 0)],
                    gain: 0.5,
                    pan: -1.0,
                    ..Track::default()
                },
                Track {
                    clips: vec![Clip::new(src, 0)],
                    muted: true,
                    ..Track::default()
                },
            ],
        ));
        let (mut player, mut handle) = player(p, 48_000, 2);
        handle.send(PlayerMsg::Play {
            from: 0,
            to: 3000,
            looping: None,
        });
        let mut out = vec![0.0; 2 * 480];
        player.fill(&mut out);
        assert_eq!(handle.take_peaks(2), vec![[0.245, 0.0], [0.0, 0.0]]);
        // Reading resets them.
        assert_eq!(handle.take_peaks(1), vec![[0.0, 0.0]]);
    }

    #[test]
    fn resamples_to_the_device_rate() {
        let (mut player, mut handle) = player(project(44_100, 44_100), 48_000, 2);
        handle.send(PlayerMsg::Play {
            from: 0,
            to: 44_100,
            looping: None,
        });
        let mut out = vec![0.0; 2 * 1024];
        for _ in 0..46 {
            player.fill(&mut out);
        }
        // 46 * 1024 device frames at 48k is about 43_281 source frames.
        let pos = handle.position();
        assert!((43_200..43_400).contains(&pos), "{pos}");
        assert!(handle.playing());
    }

    #[test]
    fn swapped_snapshots_come_back_to_the_handle() {
        let (mut player, mut handle) = player(project(48_000, 10), 48_000, 1);
        let p2 = project(48_000, 20);
        handle.send(PlayerMsg::Project(p2.clone()));
        let mut out = [0.0; 8];
        player.fill(&mut out);
        assert!(Arc::ptr_eq(player.renderer.project(), &p2));
        assert_eq!(handle.garbage.slots(), 1);
        handle.collect();
        assert_eq!(handle.garbage.slots(), 0);
    }

    #[test]
    fn the_analyser_hears_the_tapped_track() {
        // A 1500 Hz sine (32 frames a cycle), on track 7.
        let samples: Vec<f32> = (0..24_000)
            .map(|i| (0.5 * (2.0 * std::f64::consts::PI * i as f64 / 32.0).sin()) as f32)
            .collect();
        let p = Arc::new(Project::with_tracks(
            48_000,
            vec![Track {
                id: 7,
                clips: vec![Clip::new(Arc::new(Source::new(1, samples)), 0)],
                ..Track::default()
            }],
        ));
        let (mut pl, mut handle) = player(p.clone(), 48_000, 2);
        assert!(handle.spectrum(Some(7), 48_000).is_none());
        handle.send(PlayerMsg::Play {
            from: 0,
            to: 24_000,
            looping: None,
        });
        let mut out = vec![0.0; 2 * 480];
        for _ in 0..30 {
            pl.fill(&mut out);
        }
        let s = handle.spectrum(Some(7), 48_000).unwrap();
        let (i, top) =
            s.db.iter()
                .enumerate()
                .fold((0, f32::MIN), |m, (i, &d)| if d > m.1 { (i, d) } else { m });
        let hz = s.from_hz * (s.to_hz / s.from_hz).powf(i as f64 / (s.db.len() - 1) as f64);
        assert!((hz / 1500.0 - 1.0).abs() < 0.03, "peak at {hz} Hz");
        assert!((top + 6.0).abs() < 1.0, "a -6 dB sine reads {top} dB");
        // Tapping doesn't change what plays (no EQ here, so it's exact
        // to within float rounding).
        let (mut pl, mut handle) = player(p.clone(), 48_000, 2);
        handle.spectrum(Some(7), 48_000);
        handle.send(PlayerMsg::Play {
            from: 0,
            to: 960,
            looping: None,
        });
        let mut out = vec![0.0; 2 * 960];
        pl.fill(&mut out);
        let want = crate::render(p, 0, 960);
        assert!(out.iter().zip(&want).all(|(a, b)| (a - b).abs() < 1e-6));
    }
}
