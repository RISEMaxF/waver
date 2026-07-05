//! Waver native audio engine — the cpal-backed implementation of the
//! `waver_core::AudioEngine` boundary (spec §4.2).
//!
//! Milestone status:
//! - M1: device/host enumeration ([`enumerate`]) + live input metering (in progress).
//! - M2+: capture-to-disk, playback, offline mixdown.
//!
//! **Realtime safety (spec §4.4):** the cpal input/output callbacks never allocate,
//! lock, syscall, or log. Samples cross the callback→consumer boundary via a
//! lock-free SPSC ring buffer (`rtrb`).

pub mod enumerate;
pub mod meter;
pub mod metering;

pub use enumerate::{enumerate_devices, enumerate_hosts};
pub use metering::{start_metering, MeterHandle};

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

    /// Start live input metering (spec FR-2.1). `sink` is called ~50 Hz with a
    /// [`MeterUpdate`]. The returned [`MeterHandle`] stops metering when dropped.
    pub fn start_metering<S>(
        &self,
        device_id: &str,
        params: StreamParams,
        sink: S,
    ) -> Result<MeterHandle, EngineError>
    where
        S: Fn(MeterUpdate) + Send + 'static,
    {
        metering::start_metering(device_id, params, sink)
    }
}
