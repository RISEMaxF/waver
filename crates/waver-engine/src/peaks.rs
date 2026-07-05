//! Multi-resolution waveform peak generation (spec FR-3.1).
//!
//! Builds a mipmap-style pyramid of per-channel min/max pairs so the frontend can
//! render a waveform at any zoom without touching raw samples. The finest level
//! decimates the source by [`BASE_BUCKET`] frames; each coarser level halves the
//! resolution of the previous one. Levels are stored **coarsest first**.

use waver_core::engine::EngineError;
use waver_core::model::{PeakLevel, PeakPyramid};

/// Frames per bucket at the finest pyramid level.
pub const BASE_BUCKET: u32 = 256;

/// Build the finest level directly from interleaved f32 samples.
fn base_level(samples: &[f32], channels: usize, bucket: u32) -> PeakLevel {
    let ch = channels.max(1);
    let frames = samples.len() / ch;
    let n_buckets = frames.div_ceil(bucket as usize);
    let mut mins = vec![0.0f32; n_buckets * ch];
    let mut maxs = vec![0.0f32; n_buckets * ch];

    for b in 0..n_buckets {
        let start = b * bucket as usize;
        let end = ((b + 1) * bucket as usize).min(frames);
        // Initialize from the first frame in the bucket per channel.
        for c in 0..ch {
            let mut lo = f32::INFINITY;
            let mut hi = f32::NEG_INFINITY;
            for f in start..end {
                let s = samples[f * ch + c];
                if s < lo {
                    lo = s;
                }
                if s > hi {
                    hi = s;
                }
            }
            if !lo.is_finite() {
                lo = 0.0;
            }
            if !hi.is_finite() {
                hi = 0.0;
            }
            mins[b * ch + c] = lo;
            maxs[b * ch + c] = hi;
        }
    }

    PeakLevel {
        frames_per_bucket: bucket,
        channels: ch as u16,
        mins,
        maxs,
    }
}

/// Halve the resolution of `prev` (combine `factor` buckets into one).
fn coarsen(prev: &PeakLevel, factor: usize) -> PeakLevel {
    let ch = prev.channels.max(1) as usize;
    let prev_buckets = prev.mins.len() / ch;
    let n_buckets = prev_buckets.div_ceil(factor);
    let mut mins = vec![0.0f32; n_buckets * ch];
    let mut maxs = vec![0.0f32; n_buckets * ch];

    for b in 0..n_buckets {
        let start = b * factor;
        let end = ((b + 1) * factor).min(prev_buckets);
        for c in 0..ch {
            let mut lo = f32::INFINITY;
            let mut hi = f32::NEG_INFINITY;
            for p in start..end {
                lo = lo.min(prev.mins[p * ch + c]);
                hi = hi.max(prev.maxs[p * ch + c]);
            }
            if !lo.is_finite() {
                lo = 0.0;
            }
            if !hi.is_finite() {
                hi = 0.0;
            }
            mins[b * ch + c] = lo;
            maxs[b * ch + c] = hi;
        }
    }

    PeakLevel {
        frames_per_bucket: prev.frames_per_bucket * factor as u32,
        channels: prev.channels,
        mins,
        maxs,
    }
}

/// Build a peak pyramid from interleaved f32 samples (pure; spec FR-3.1). Levels are
/// ordered coarsest first.
pub fn build_pyramid(samples: &[f32], channels: usize, base_bucket: u32) -> PeakPyramid {
    let base_bucket = base_bucket.max(1);
    if samples.is_empty() || channels == 0 {
        return PeakPyramid::default();
    }
    let mut fine_first = vec![base_level(samples, channels, base_bucket)];
    // Coarsen until a level has a single bucket.
    while (fine_first.last().unwrap().mins.len() / channels.max(1)) > 1 {
        let next = coarsen(fine_first.last().unwrap(), 2);
        let is_single = (next.mins.len() / channels.max(1)) <= 1;
        fine_first.push(next);
        if is_single {
            break;
        }
    }
    fine_first.reverse(); // coarsest first
    PeakPyramid { levels: fine_first }
}

/// Read a WAV file and build its peak pyramid (spec FR-3.1).
pub fn generate_for_wav(path: impl AsRef<std::path::Path>) -> Result<PeakPyramid, EngineError> {
    let mut reader = hound::WavReader::open(path.as_ref())
        .map_err(|e| EngineError::Io(format!("open {}: {e}", path.as_ref().display())))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;

    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| EngineError::Io(format!("read samples: {e}")))?,
        hound::SampleFormat::Int => {
            let max = (1u64 << (spec.bits_per_sample.saturating_sub(1))) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<Result<_, _>>()
                .map_err(|e| EngineError::Io(format!("read samples: {e}")))?
        }
    };

    Ok(build_pyramid(&samples, channels, BASE_BUCKET))
}

/// Encode a pyramid to a compact little-endian binary blob for the frontend
/// (bypasses JSON per spec §4.3). Layout:
/// ```text
/// u32 num_levels
/// per level: u32 frames_per_bucket, u16 channels, u32 num_buckets,
///            f32[num_buckets*channels] mins, f32[num_buckets*channels] maxs
/// ```
pub fn encode_pyramid(pyramid: &PeakPyramid) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(pyramid.levels.len() as u32).to_le_bytes());
    for level in &pyramid.levels {
        let ch = level.channels.max(1) as usize;
        let n_buckets = (level.mins.len() / ch) as u32;
        out.extend_from_slice(&level.frames_per_bucket.to_le_bytes());
        out.extend_from_slice(&level.channels.to_le_bytes());
        out.extend_from_slice(&n_buckets.to_le_bytes());
        for &m in &level.mins {
            out.extend_from_slice(&m.to_le_bytes());
        }
        for &m in &level.maxs {
            out.extend_from_slice(&m.to_le_bytes());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_level_captures_min_max() {
        // Mono ramp -1..1 over 512 frames, bucket 256 -> 2 buckets.
        let n = 512;
        let samples: Vec<f32> = (0..n)
            .map(|i| -1.0 + 2.0 * i as f32 / (n - 1) as f32)
            .collect();
        let level = base_level(&samples, 1, 256);
        assert_eq!(level.mins.len(), 2);
        assert!((level.mins[0] - (-1.0)).abs() < 1e-6); // first bucket min
        assert!(level.maxs[1] >= 0.99); // last bucket max ~1.0
    }

    #[test]
    fn pyramid_is_coarsest_first_and_shrinks() {
        let samples: Vec<f32> = (0..48_000).map(|i| (i as f32 * 0.01).sin()).collect();
        let p = build_pyramid(&samples, 1, 256);
        assert!(p.levels.len() >= 2);
        // Coarsest first: bucket sizes strictly decreasing.
        for w in p.levels.windows(2) {
            assert!(
                w[0].frames_per_bucket > w[1].frames_per_bucket,
                "levels must be coarsest-first"
            );
        }
        // Coarsest level collapses to a single bucket.
        assert_eq!(p.levels[0].mins.len(), 1);
        // Finest level uses the base bucket.
        assert_eq!(p.levels.last().unwrap().frames_per_bucket, 256);
    }

    #[test]
    fn stereo_channels_are_independent() {
        // L = +0.5 constant, R = -0.5 constant, 300 frames.
        let mut samples = Vec::new();
        for _ in 0..300 {
            samples.push(0.5); // L
            samples.push(-0.5); // R
        }
        let level = base_level(&samples, 2, 256);
        // 300 frames / 256 -> 2 buckets, 2 channels each.
        assert_eq!(level.mins.len(), 4);
        // Bucket 0: L min/max = 0.5, R min/max = -0.5
        assert_eq!(level.mins[0], 0.5); // ch0
        assert_eq!(level.maxs[0], 0.5);
        assert_eq!(level.mins[1], -0.5); // ch1
        assert_eq!(level.maxs[1], -0.5);
    }

    #[test]
    fn encode_roundtrip_header() {
        let samples: Vec<f32> = (0..1000).map(|i| i as f32 / 1000.0).collect();
        let p = build_pyramid(&samples, 1, 256);
        let bytes = encode_pyramid(&p);
        let num_levels = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        assert_eq!(num_levels as usize, p.levels.len());
    }

    #[test]
    fn empty_input_is_safe() {
        assert!(build_pyramid(&[], 2, 256).levels.is_empty());
        assert!(build_pyramid(&[0.1, 0.2], 0, 256).levels.is_empty());
    }

    #[test]
    fn generate_from_written_wav() {
        // Write a stereo float WAV, then generate its pyramid from disk.
        use crate::capture::WavRecorder;
        let path = std::env::temp_dir().join("waver_test_peaks.wav");
        let mut rec = WavRecorder::create(&path, 2, 48_000).unwrap();
        let mut block = Vec::new();
        for i in 0..2000 {
            block.push((i as f32 * 0.02).sin()); // L
            block.push(-0.3); // R constant
        }
        rec.write_interleaved(&block).unwrap();
        rec.finalize().unwrap();

        let pyramid = generate_for_wav(&path).unwrap();
        assert!(!pyramid.levels.is_empty());
        let finest = pyramid.levels.last().unwrap();
        assert_eq!(finest.channels, 2);
        // R channel is constant -0.3, so its min == max == -0.3 in every bucket.
        for b in 0..finest.mins.len() / 2 {
            assert!((finest.mins[b * 2 + 1] - (-0.3)).abs() < 1e-4);
            assert!((finest.maxs[b * 2 + 1] - (-0.3)).abs() < 1e-4);
        }
        let _ = std::fs::remove_file(&path);
    }
}
