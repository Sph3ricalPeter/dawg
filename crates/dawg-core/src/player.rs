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

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use rtrb::{Consumer, Producer, RingBuffer};

use crate::model::Project;
use crate::render::{Renderer, OUT_CHANNELS};

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

#[derive(Default)]
pub struct PlayerShared {
    playing: AtomicBool,
    position: AtomicU64,
}

/// The control side. Not real-time; lives with the app state.
pub struct PlayerHandle {
    tx: Producer<PlayerMsg>,
    garbage: Consumer<Arc<Project>>,
    shared: Arc<PlayerShared>,
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
    let player = Player {
        rx,
        garbage: gtx,
        shared: shared.clone(),
        renderer: Renderer::new(project, 0),
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
            self.renderer.process(&mut self.block);
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
}
