//! WAV capture writer (spec FR-2.2 / FR-2.3).
//!
//! Records to **32-bit float** WAV. Device samples are converted to f32 losslessly
//! (integer formats map exactly into f32's mantissa) and written verbatim — no gain,
//! no normalization, no dithering, no resampling. The write path therefore adds
//! nothing to the signal: it is bit-transparent by construction (spec FR-2.3), and
//! the flagship acceptance test is the analog loopback (documented as manual QA).
//!
//! Writing is incremental via a buffered writer, so memory stays bounded regardless
//! of recording length (spec FR-2.2).

use std::io::BufWriter;
use std::path::{Path, PathBuf};

use waver_core::engine::EngineError;

/// Metadata about a finished recording, used to build a [`waver_core::Source`].
#[derive(Debug, Clone)]
pub struct RecordingInfo {
    pub path: PathBuf,
    pub channels: u16,
    pub sample_rate: u32,
    /// Length in frames (samples per channel).
    pub frames: u64,
}

/// Streams interleaved f32 samples to a 32-bit float WAV file.
pub struct WavRecorder {
    writer: hound::WavWriter<BufWriter<std::fs::File>>,
    path: PathBuf,
    channels: u16,
    sample_rate: u32,
    samples_written: u64,
}

impl WavRecorder {
    /// Create a new 32-bit float WAV at `path` with the given format.
    pub fn create(
        path: impl AsRef<Path>,
        channels: u16,
        sample_rate: u32,
    ) -> Result<Self, EngineError> {
        let spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let writer = hound::WavWriter::create(path.as_ref(), spec)
            .map_err(|e| EngineError::Io(format!("create {}: {e}", path.as_ref().display())))?;
        Ok(Self {
            writer,
            path: path.as_ref().to_path_buf(),
            channels,
            sample_rate,
            samples_written: 0,
        })
    }

    /// Append an interleaved f32 block (already in the device's native values). No
    /// processing is applied — the samples are written exactly as received.
    pub fn write_interleaved(&mut self, block: &[f32]) -> Result<(), EngineError> {
        for &sample in block {
            self.writer
                .write_sample(sample)
                .map_err(|e| EngineError::Io(format!("write sample: {e}")))?;
        }
        self.samples_written += block.len() as u64;
        Ok(())
    }

    /// Finalize the WAV (flush + patch the RIFF header) and report what was written.
    pub fn finalize(self) -> Result<RecordingInfo, EngineError> {
        let frames = self.samples_written / self.channels.max(1) as u64;
        let info = RecordingInfo {
            path: self.path,
            channels: self.channels,
            sample_rate: self.sample_rate,
            frames,
        };
        self.writer
            .finalize()
            .map_err(|e| EngineError::Io(format!("finalize wav: {e}")))?;
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_back(path: &Path) -> (hound::WavSpec, Vec<f32>) {
        let mut reader = hound::WavReader::open(path).expect("open wav");
        let spec = reader.spec();
        let samples: Vec<f32> = reader.samples::<f32>().map(|s| s.unwrap()).collect();
        (spec, samples)
    }

    #[test]
    fn round_trip_is_bit_exact() {
        // The write path must be bit-transparent (spec FR-2.3): what we write is what
        // we read back, exactly — including full-scale and very quiet samples.
        let dir = std::env::temp_dir();
        let path = dir.join("waver_test_bitexact.wav");
        let input: Vec<f32> = vec![
            0.0,
            1.0,
            -1.0,
            0.5,
            -0.5,
            1.0e-6, // -120 dBFS, must survive exactly in f32
            -1.0e-6,
            0.123_456_79,
            f32::from_bits(0x3f800001), // 1.0 + 1 ULP
        ];
        // Write as mono.
        let mut rec = WavRecorder::create(&path, 1, 48_000).unwrap();
        rec.write_interleaved(&input).unwrap();
        let info = rec.finalize().unwrap();
        assert_eq!(info.frames, input.len() as u64);

        let (spec, out) = read_back(&path);
        assert_eq!(spec.bits_per_sample, 32);
        assert_eq!(spec.sample_format, hound::SampleFormat::Float);
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, 48_000);
        assert_eq!(
            out, input,
            "recorded samples must be bit-identical to input"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn no_gain_applied() {
        // Clean capture (spec FR-2.3): a full-scale value and a -60 dBFS value must
        // both come back unchanged — no normalization / AGC pumping.
        let path = std::env::temp_dir().join("waver_test_nogain.wav");
        let full_scale = 1.0f32;
        let quiet = 10f32.powf(-60.0 / 20.0); // 0.001
        let input = vec![full_scale, quiet, full_scale, quiet];
        let mut rec = WavRecorder::create(&path, 1, 48_000).unwrap();
        rec.write_interleaved(&input).unwrap();
        rec.finalize().unwrap();
        let (_, out) = read_back(&path);
        assert_eq!(out, input);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn multichannel_channels_are_preserved() {
        // Stereo interleaved [L,R,...]: distinct per-channel content must round-trip
        // to the correct channel (spec FR-2.4).
        let path = std::env::temp_dir().join("waver_test_multichannel.wav");
        // L ramps up, R is constant -0.25.
        let mut input = Vec::new();
        for i in 0..8 {
            input.push(i as f32 / 8.0); // L
            input.push(-0.25); // R
        }
        let mut rec = WavRecorder::create(&path, 2, 48_000).unwrap();
        rec.write_interleaved(&input).unwrap();
        let info = rec.finalize().unwrap();
        assert_eq!(info.frames, 8);

        let (spec, out) = read_back(&path);
        assert_eq!(spec.channels, 2);
        // De-interleave and check.
        for i in 0..8 {
            assert_eq!(out[i * 2], i as f32 / 8.0, "L[{i}]");
            assert_eq!(out[i * 2 + 1], -0.25, "R[{i}]");
        }
        let _ = std::fs::remove_file(&path);
    }
}
