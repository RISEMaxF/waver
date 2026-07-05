//! Realtime-safe level metering math (spec FR-2.1).
//!
//! Split into two halves:
//! - [`frame_from_interleaved`] runs *inside* the cpal audio callback. It is
//!   alloc-free, lock-free, and syscall-free: it reduces an interleaved sample block
//!   to a fixed-size [`MeterFrame`] (per-channel peak + sum-of-squares) on the stack.
//! - [`MeterAccumulator`] runs on the (non-realtime) emitter thread. It aggregates
//!   frames over a display window and converts to dBFS.

use cpal::{FromSample, Sample};
use waver_core::engine::{ChannelLevel, MeterUpdate};

/// Maximum channels a single meter frame tracks. A stack array of this size keeps
/// the audio callback allocation-free regardless of device channel count.
pub const MAX_METER_CHANNELS: usize = 32;

/// Floor for dBFS readings; silence maps here instead of `-inf`.
pub const DBFS_FLOOR: f32 = -120.0;

/// A fixed-size, `Copy` summary of one audio callback block. Sent through the
/// lock-free ring buffer to the emitter thread. Contains no heap data.
#[derive(Clone, Copy)]
pub struct MeterFrame {
    /// Number of valid channels (<= [`MAX_METER_CHANNELS`]).
    pub channels: usize,
    /// Per-channel linear absolute peak.
    pub peak: [f32; MAX_METER_CHANNELS],
    /// Per-channel sum of squares (f64 to avoid precision loss when accumulated).
    pub sumsq: [f64; MAX_METER_CHANNELS],
    /// Number of frames (samples per channel) represented.
    pub frames: u64,
}

impl MeterFrame {
    pub const SILENT: MeterFrame = MeterFrame {
        channels: 0,
        peak: [0.0; MAX_METER_CHANNELS],
        sumsq: [0.0; MAX_METER_CHANNELS],
        frames: 0,
    };
}

/// Reduce an interleaved sample block to a [`MeterFrame`]. **Realtime-safe** and
/// called from inside the cpal audio callback.
///
/// § Why running this in the callback is RT-safe (spec §4.4):
/// The §4.4 hard rule is *no heap allocation, no locking, no syscalls, no logging*.
/// This function does none of those — it writes only to fixed-size stack arrays and
/// returns a `Copy` value. It performs a bounded `O(block_len)` pass of plain float
/// arithmetic (abs / max / multiply-add). Note the canonical "just copy samples to
/// the ring" pattern *also* converts every sample to f32 in the callback; this adds
/// only ~2–3 float ops per sample on top of that same conversion, so it is not
/// meaningfully more work — and it moves far less data across the SPSC boundary (one
/// small summary per block instead of every sample). The raw-samples-to-disk drain
/// path described in §4.4 is a separate concern that arrives with capture in M2.
///
/// Generic over the device sample type `T` (f32/i16/…); samples are converted to
/// normalized f32 for the level math. `channels` is the interleave stride.
pub fn frame_from_interleaved<T>(block: &[T], channels: usize) -> MeterFrame
where
    T: Copy,
    f32: FromSample<T>,
{
    let ch = channels.min(MAX_METER_CHANNELS);
    let mut peak = [0.0f32; MAX_METER_CHANNELS];
    let mut sumsq = [0.0f64; MAX_METER_CHANNELS];

    if channels == 0 {
        return MeterFrame::SILENT;
    }

    for (i, &sample) in block.iter().enumerate() {
        let c = i % channels;
        if c >= ch {
            continue; // channel beyond what we track; ignore
        }
        let s: f32 = f32::from_sample(sample);
        let a = s.abs();
        if a > peak[c] {
            peak[c] = a;
        }
        sumsq[c] += (s as f64) * (s as f64);
    }

    MeterFrame {
        channels: ch,
        peak,
        sumsq,
        frames: (block.len() / channels) as u64,
    }
}

/// Convert a linear amplitude (0..=1 nominal) to dBFS, clamped at [`DBFS_FLOOR`].
pub fn lin_to_dbfs(x: f32) -> f32 {
    if x <= 0.0 {
        DBFS_FLOOR
    } else {
        (20.0 * x.log10()).max(DBFS_FLOOR)
    }
}

/// Aggregates [`MeterFrame`]s over a display window (non-realtime thread) and emits
/// a [`MeterUpdate`]. Peak is the max over the window; RMS is computed over all
/// samples in the window.
pub struct MeterAccumulator {
    channels: usize,
    peak: [f32; MAX_METER_CHANNELS],
    sumsq: [f64; MAX_METER_CHANNELS],
    frames: u64,
}

impl Default for MeterAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl MeterAccumulator {
    pub fn new() -> Self {
        Self {
            channels: 0,
            peak: [0.0; MAX_METER_CHANNELS],
            sumsq: [0.0; MAX_METER_CHANNELS],
            frames: 0,
        }
    }

    /// True if any samples have been accumulated since the last drain.
    pub fn has_data(&self) -> bool {
        self.frames > 0
    }

    pub fn add(&mut self, f: &MeterFrame) {
        self.channels = self.channels.max(f.channels);
        for c in 0..f.channels {
            if f.peak[c] > self.peak[c] {
                self.peak[c] = f.peak[c];
            }
            self.sumsq[c] += f.sumsq[c];
        }
        self.frames += f.frames;
    }

    /// Produce a [`MeterUpdate`] for the accumulated window and reset for the next.
    /// Returns per-channel peak & RMS in dBFS.
    pub fn drain_to_update(&mut self) -> MeterUpdate {
        let frames = self.frames.max(1) as f64;
        let channels = (0..self.channels)
            .map(|c| {
                let rms = (self.sumsq[c] / frames).sqrt() as f32;
                ChannelLevel {
                    peak_dbfs: lin_to_dbfs(self.peak[c]),
                    rms_dbfs: lin_to_dbfs(rms),
                }
            })
            .collect();

        // Reset.
        self.peak = [0.0; MAX_METER_CHANNELS];
        self.sumsq = [0.0; MAX_METER_CHANNELS];
        self.frames = 0;
        // Keep self.channels so a silent window still reports the right channel count.

        MeterUpdate { channels }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn sine(amp: f32, freq: f32, sr: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (2.0 * PI * freq * i as f32 / sr).sin())
            .collect()
    }

    #[test]
    fn dbfs_reference_points() {
        assert!((lin_to_dbfs(1.0) - 0.0).abs() < 1e-4); // full scale = 0 dBFS
        assert!((lin_to_dbfs(0.5) - (-6.0206)).abs() < 1e-3); // half = ~-6.02 dBFS
        assert_eq!(lin_to_dbfs(0.0), DBFS_FLOOR); // silence -> floor
    }

    /// Flagship FR-2.1 DoD: a known -6 dBFS tone reads -6 dBFS +-0.5 dB on the meter.
    #[test]
    fn minus_6_dbfs_sine_reads_minus_6_peak() {
        let amp = 10f32.powf(-6.0 / 20.0); // -6 dBFS amplitude ~= 0.5012
        let block = sine(amp, 1000.0, 48_000.0, 48_000); // 1s @ 48k, mono
        let frame = frame_from_interleaved(&block, 1);

        let mut acc = MeterAccumulator::new();
        acc.add(&frame);
        let update = acc.drain_to_update();

        assert_eq!(update.channels.len(), 1);
        let peak = update.channels[0].peak_dbfs;
        assert!(
            (peak - (-6.0)).abs() <= 0.5,
            "peak {peak} dBFS not within -6 +-0.5"
        );

        // RMS of a sine is peak - 3.01 dB, so ~-9.01 dBFS here.
        let rms = update.channels[0].rms_dbfs;
        assert!((rms - (-9.01)).abs() <= 0.5, "rms {rms} dBFS not ~-9.01");
    }

    #[test]
    fn full_scale_sine_reads_0_dbfs_peak() {
        let block = sine(1.0, 997.0, 48_000.0, 48_000);
        let frame = frame_from_interleaved(&block, 1);
        let mut acc = MeterAccumulator::new();
        acc.add(&frame);
        let peak = acc.drain_to_update().channels[0].peak_dbfs;
        assert!((peak - 0.0).abs() <= 0.5, "peak {peak} not ~0 dBFS");
    }

    #[test]
    fn interleaved_channels_are_separated() {
        // Stereo: left full-scale, right at -6 dBFS. Interleaved [L,R,L,R,...].
        let left = sine(1.0, 1000.0, 48_000.0, 4_800);
        let right = sine(10f32.powf(-6.0 / 20.0), 1000.0, 48_000.0, 4_800);
        let mut inter = Vec::with_capacity(left.len() * 2);
        for i in 0..left.len() {
            inter.push(left[i]);
            inter.push(right[i]);
        }
        let frame = frame_from_interleaved(&inter, 2);
        assert_eq!(frame.channels, 2);
        assert_eq!(frame.frames, 4_800);

        let mut acc = MeterAccumulator::new();
        acc.add(&frame);
        let u = acc.drain_to_update();
        assert!(
            (u.channels[0].peak_dbfs - 0.0).abs() <= 0.5,
            "L {}",
            u.channels[0].peak_dbfs
        );
        assert!(
            (u.channels[1].peak_dbfs - (-6.0)).abs() <= 0.5,
            "R {}",
            u.channels[1].peak_dbfs
        );
    }

    #[test]
    fn i16_samples_convert_correctly() {
        // A half-scale i16 square-ish block should read ~-6 dBFS peak.
        let half = i16::MAX / 2;
        let block = vec![half, -half, half, -half];
        let frame = frame_from_interleaved(&block, 1);
        let mut acc = MeterAccumulator::new();
        acc.add(&frame);
        let peak = acc.drain_to_update().channels[0].peak_dbfs;
        assert!((peak - (-6.0)).abs() <= 0.6, "i16 half-scale peak {peak}");
    }
}
