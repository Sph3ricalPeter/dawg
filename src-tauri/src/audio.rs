//! The output device. Opened on first play, rebuilt after the device goes
//! away; all the real-time work is in `dawg_core::player`.

use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use dawg_core::player::{player, Player, PlayerHandle, PlayerMsg, Spectrum};
use dawg_core::Project;

/// Frames converted per pass for devices that don't take `f32`.
const CONVERT_FRAMES: usize = 1024;

struct Output {
    handle: PlayerHandle,
    dead: Arc<std::sync::atomic::AtomicBool>,
    /// Dropping it ends the thread that owns the stream.
    _stop: mpsc::Sender<()>,
}

#[derive(Default)]
pub struct Audio {
    output: Option<Output>,
    project: Option<Arc<Project>>,
}

impl Audio {
    /// The project to play from now on.
    pub fn set_project(&mut self, project: Arc<Project>) {
        self.project = Some(project.clone());
        if let Some(out) = &mut self.output {
            out.handle.send(PlayerMsg::Project(project));
        }
    }

    pub fn play(&mut self, from: u64, to: u64, looping: Option<u64>) -> Result<(), String> {
        let project = self.project.clone().ok_or("nothing to play")?;
        let dead = self
            .output
            .as_ref()
            .is_none_or(|o| o.dead.load(std::sync::atomic::Ordering::Relaxed));
        if dead {
            self.output = None;
            self.output = Some(open(project)?);
        }
        let out = self.output.as_mut().expect("output just opened");
        if !out.handle.send(PlayerMsg::Play { from, to, looping }) {
            return Err("the audio device stopped responding".into());
        }
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(out) = &mut self.output {
            out.handle.send(PlayerMsg::Stop);
        }
    }

    /// Whether it is playing, the timeline frame being heard, and each
    /// track's peak level (left, right) since the last call.
    pub fn status(&mut self) -> (bool, u64, Vec<[f32; 2]>) {
        let tracks = self.project.as_ref().map_or(0, |p| p.tracks.len());
        match &mut self.output {
            Some(out) => {
                out.handle.collect();
                (
                    out.handle.playing(),
                    out.handle.position(),
                    out.handle.take_peaks(tracks),
                )
            }
            None => (false, 0, Vec::new()),
        }
    }
}

impl Audio {
    /// The spectrum of `track` after its EQ since the last call, and from
    /// now on listens to it; `None` stops listening.
    pub fn spectrum(&mut self, track: Option<u64>) -> Option<Spectrum> {
        let rate = self.project.as_ref()?.sample_rate;
        self.output.as_mut()?.handle.spectrum(track, rate)
    }
}

fn open(project: Arc<Project>) -> Result<Output, String> {
    let (ready_tx, ready_rx) = mpsc::channel();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let dead = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dead2 = dead.clone();
    // Streams aren't `Send` on every platform, so one thread builds, owns and
    // finally drops it.
    thread::Builder::new()
        .name("dawg-audio".into())
        .spawn(move || match build(project, dead2) {
            Ok((stream, handle)) => {
                let _ = ready_tx.send(Ok(handle));
                let _ = stop_rx.recv();
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;
    let handle = ready_rx
        .recv()
        .map_err(|_| "the audio thread quit".to_string())??;
    Ok(Output {
        handle,
        dead,
        _stop: stop_tx,
    })
}

fn build(
    project: Arc<Project>,
    dead: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(cpal::Stream, PlayerHandle), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("no audio output device")?;
    let supported = device
        .default_output_config()
        .map_err(|e| format!("can't use the audio device: {e}"))?;
    let config = supported.config();
    let (player, handle) = player(project, config.sample_rate, config.channels as usize);
    let on_error = move |e: cpal::Error| {
        if !matches!(e.kind(), cpal::ErrorKind::DeviceChanged) {
            eprintln!("audio device error: {e}");
            dead.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    };
    let stream = match supported.sample_format() {
        SampleFormat::F32 => {
            let mut player = player;
            device.build_output_stream(
                config,
                move |out: &mut [f32], _| player.fill(out),
                on_error,
                None,
            )
        }
        SampleFormat::I16 => build_converting::<i16>(&device, config, player, on_error),
        SampleFormat::I32 => build_converting::<i32>(&device, config, player, on_error),
        SampleFormat::U16 => build_converting::<u16>(&device, config, player, on_error),
        other => return Err(format!("the audio device wants {other} samples")),
    }
    .map_err(|e| format!("can't open the audio device: {e}"))?;
    stream
        .play()
        .map_err(|e| format!("can't start the audio device: {e}"))?;
    Ok((stream, handle))
}

fn build_converting<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut player: Player,
    on_error: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample + FromSample<f32>,
{
    let ch = config.channels as usize;
    let mut scratch = vec![0.0f32; CONVERT_FRAMES * ch];
    device.build_output_stream(
        config,
        move |out: &mut [T], _| {
            for chunk in out.chunks_mut(CONVERT_FRAMES * ch) {
                let buf = &mut scratch[..chunk.len()];
                player.fill(buf);
                for (o, &s) in chunk.iter_mut().zip(buf.iter()) {
                    *o = T::from_sample(s);
                }
            }
        },
        on_error,
        None,
    )
}
