//! Waver native audio engine — the cpal-backed implementation of the
//! `waver_core::AudioEngine` boundary (spec §4.2).
//!
//! Milestone status:
//! - M1: device/host enumeration ([`enumerate`]) + live input metering.
//! - M2: clean capture to disk ([`capture`], [`input`]).
//! - M3+: playback, offline mixdown.
//!
//! **Realtime safety (spec §4.4):** the cpal input/output callbacks never allocate,
//! lock, syscall, or log. Samples cross the callback→consumer boundary via a
//! lock-free SPSC ring buffer (`rtrb`); a separate consumer thread meters and writes
//! to disk.

pub mod capture;
pub mod enumerate;
pub mod export;
pub mod import;
pub mod input;
pub mod meter;
pub mod mixer;
pub mod peaks;
pub mod playback;

pub use capture::{RecordingInfo, WavRecorder};
pub use enumerate::{enumerate_devices, enumerate_hosts};
pub use export::{export_project, BitDepth, ExportFormat, ExportOptions};
pub use import::{import_file, ImportInfo};
pub use input::{open as open_input, InputSession};
pub use mixer::{decode_wav, DecodedSource, Mixer};
pub use peaks::{build_pyramid, encode_pyramid, generate_for_wav};
pub use playback::{start as start_playback, LoopRegion, Playback};

use waver_core::engine::{DeviceInfo, EngineError, HostInfo, MeterUpdate, StreamParams};

/// The native (cpal) audio engine.
#[derive(Default)]
pub struct NativeEngine {}

impl NativeEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enumerate all input and output devices across all hosts (spec FR-1.1).
    pub fn list_devices(&self) -> Result<Vec<DeviceInfo>, EngineError> {
        Ok(enumerate_devices())
    }

    /// List the hosts/backends available in this build.
    pub fn list_hosts(&self) -> Result<Vec<HostInfo>, EngineError> {
        Ok(enumerate_hosts())
    }

    /// Open a live input session: metering (spec FR-2.1) starts immediately and
    /// recording (spec FR-2.2/2.3/2.4) can be toggled on the returned [`InputSession`].
    /// `meter_sink` is called ~80 Hz with a [`MeterUpdate`].
    pub fn open_input<S>(
        &self,
        device_id: &str,
        params: StreamParams,
        meter_sink: S,
    ) -> Result<InputSession, EngineError>
    where
        S: Fn(MeterUpdate) + Send + 'static,
    {
        input::open(device_id, params, meter_sink)
    }
}
