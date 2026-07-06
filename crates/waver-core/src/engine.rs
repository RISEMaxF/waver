//! The audio-engine boundary (spec §4.2).
//!
//! v1 ships a single implementation, `NativeEngine` (cpal-backed, in the `src-tauri`
//! crate / a future `waver-engine` crate). A future `WebEngine` can implement the
//! same trait for a PWA build without touching the timeline/editing logic. **Do not**
//! build `WebEngine` in v1 — just keep this boundary clean so it stays possible.
//!
//! The signatures here are intentionally backend-agnostic. Concrete streaming types
//! (level meters, capture progress) are delivered over Tauri `Channel`s at the
//! `src-tauri` layer, not returned synchronously from these methods; this trait
//! covers lifecycle control only.

use serde::{Deserialize, Serialize};

use crate::model::Project;

/// Errors an [`AudioEngine`] can surface. Backend-specific errors (cpal, WASAPI, …)
/// are mapped onto these variants at the boundary.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("no such device: {0}")]
    DeviceNotFound(String),
    #[error("unsupported stream configuration: {0}")]
    UnsupportedConfig(String),
    #[error("device disconnected")]
    DeviceDisconnected,
    #[error("engine is already capturing")]
    AlreadyCapturing,
    #[error("engine is not capturing")]
    NotCapturing,
    #[error("i/o error: {0}")]
    Io(String),
    #[error("{0}")]
    Backend(String),
}

/// Whether a device is an input (capture) or output (playback) endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceDirection {
    Input,
    Output,
}

/// An audio host (backend) available on the platform, e.g. CoreAudio, WASAPI, ALSA.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostInfo {
    pub name: String,
    pub is_default: bool,
}

/// A selectable audio device (spec FR-1.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceInfo {
    /// Stable identifier used to re-select the device across restarts (spec FR-1.2).
    pub id: String,
    pub name: String,
    pub host: String,
    pub direction: DeviceDirection,
    pub is_default: bool,
    /// Supported channel counts.
    pub channels: Vec<u16>,
    /// Supported sample rates (Hz).
    pub sample_rates: Vec<u32>,
}

/// A per-channel level reading (spec FR-2.1), in dBFS.
///
/// dBFS is amplitude-referenced: a full-scale sine peaks at 0 dBFS, and its RMS is
/// ~-3.01 dBFS. So a -6 dBFS sine reads -6 dBFS peak and ~-9 dBFS RMS.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ChannelLevel {
    pub peak_dbfs: f32,
    pub rms_dbfs: f32,
}

/// A metering update streamed to the frontend over a Tauri Channel (spec FR-2.1),
/// one [`ChannelLevel`] per input channel. `wave_min`/`wave_max` are the signed
/// linear sample extremes of the window across all channels — used to draw the live
/// waveform while recording.
#[derive(Debug, Clone, Serialize)]
pub struct MeterUpdate {
    pub channels: Vec<ChannelLevel>,
    pub wave_min: f32,
    pub wave_max: f32,
}

/// Concrete stream parameters chosen by the user (spec FR-1.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamParams {
    pub sample_rate: u32,
    pub channels: u16,
    /// Fixed buffer size in frames, or `None` to let the backend choose (the chosen
    /// value is then reported back for display).
    pub buffer_frames: Option<u32>,
}

/// The backend-agnostic audio engine (spec §4.2).
///
/// **Realtime safety (spec §4.4):** implementations must not allocate, lock, perform
/// syscalls, or log inside the audio callback. Samples cross the callback→writer
/// boundary via a lock-free SPSC ring buffer.
pub trait AudioEngine {
    /// Enumerate all input and output devices across available hosts (FR-1.1).
    fn list_devices(&self) -> Result<Vec<DeviceInfo>, EngineError>;

    /// List available hosts/backends.
    fn list_hosts(&self) -> Result<Vec<HostInfo>, EngineError>;

    /// Open an input device with the given parameters, readying it for capture.
    fn open_input(&mut self, device_id: &str, params: StreamParams) -> Result<(), EngineError>;

    /// Begin streaming the opened input to `scratch_path` on disk (FR-2.2). Capture
    /// applies **zero** DSP (FR-2.3).
    fn start_capture(&mut self, scratch_path: &std::path::Path) -> Result<(), EngineError>;

    /// Stop the active capture and finalize the scratch file.
    fn stop_capture(&mut self) -> Result<(), EngineError>;

    /// Play the given project through the selected output device (FR-6.1),
    /// starting at `start_frame` on the project timeline.
    fn play(&mut self, project: &Project, start_frame: u64) -> Result<(), EngineError>;

    /// Stop playback.
    fn stop(&mut self) -> Result<(), EngineError>;

    /// Render the full project offline to `out_path` (FR-7.2). Not realtime-bound.
    fn render_mixdown(
        &self,
        project: &Project,
        out_path: &std::path::Path,
    ) -> Result<(), EngineError>;
}
