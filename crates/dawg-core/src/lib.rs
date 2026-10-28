//! Headless core of dawg: the project model and the mixer that renders it.
//!
//! Nothing here knows about the UI or the audio device. The app, the CLI and
//! the MCP server all drive the same types, and every render goes through
//! [`Renderer::process`], the function the audio callback calls. That keeps
//! playback and export sample-identical and lets the golden-render tests cover
//! the real-time path.

pub mod command;
mod model;
pub mod peaks;
pub mod player;
mod render;
pub mod save;
pub mod session;
pub mod wav;

pub use command::{ClipRef, Command, CommandError};
pub use model::{Clip, Project, Source, Track};
pub use render::{render, Renderer, OUT_CHANNELS};
pub use session::Session;

/// Version of the core crate, shared with the app so both report the same build.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
