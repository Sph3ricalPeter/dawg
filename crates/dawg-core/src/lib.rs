//! Headless core of dawg: the project model and the mixer that renders it.
//!
//! Nothing here knows about the UI or the audio device. The app, the CLI and
//! the MCP server all drive the same types, and every render goes through
//! [`Renderer::process`], the function the audio callback calls. That keeps
//! playback and export sample-identical and lets the golden-render tests cover
//! the real-time path.

pub mod command;
pub mod eq;
pub mod file;
mod model;
pub mod mp3;
pub mod peaks;
pub mod player;
pub mod project_file;
mod render;
pub mod resample;
pub mod save;
pub mod session;
pub mod stretch;
pub mod wav;

pub use command::{Command, CommandError};
pub use eq::{BandKind, Eq, EqBand};
pub use model::{Clip, EnvPoint, FadeCurve, Project, Source, Track, ENV_MAX};
pub use render::{render, Renderer, OUT_CHANNELS};
pub use session::Session;

/// Version of the core crate, shared with the app so both report the same build.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
