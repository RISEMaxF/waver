//! Lightweight source-audio analysis (zero-crossing lookup for click-free edits).

use std::path::Path;

use crate::EngineError;

/// Nearest zero crossing to `frame` in the source WAV, searched within ±`window`
/// frames on the first channel. Falls back to `frame` itself when no crossing is
/// found (silence or constant DC) — the edit still applies, just unsnapped.
pub fn nearest_zero_crossing(path: &Path, frame: u64, window: u64) -> Result<u64, EngineError> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| EngineError::Io(format!("open {}: {e}", path.display())))?;
    let spec = reader.spec();
    let total = u64::from(reader.duration());
    if total == 0 {
        return Ok(frame);
    }
    let center = frame.min(total - 1);
    let start = center.saturating_sub(window);
    let end = (center + window).min(total - 1);
    reader
        .seek(start as u32)
        .map_err(|e| EngineError::Io(format!("seek {}: {e}", path.display())))?;

    // First channel only — enough to kill clicks, cheap to scan.
    let ch = spec.channels.max(1) as usize;
    let want = ((end - start + 1) as usize) * ch;
    let mut mono: Vec<f32> = Vec::with_capacity(want / ch + 1);
    match spec.sample_format {
        hound::SampleFormat::Float => {
            for (i, s) in reader.samples::<f32>().take(want).enumerate() {
                let v = s.map_err(|e| EngineError::Io(format!("read: {e}")))?;
                if i % ch == 0 {
                    mono.push(v);
                }
            }
        }
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1i64 << (spec.bits_per_sample - 1)) as f32;
            for (i, s) in reader.samples::<i32>().take(want).enumerate() {
                let v = s.map_err(|e| EngineError::Io(format!("read: {e}")))?;
                if i % ch == 0 {
                    mono.push(v as f32 * scale);
                }
            }
        }
    }

    let target = (center - start) as i64;
    let mut best: Option<(i64, u64)> = None; // (distance, frame)
    for i in 0..mono.len().saturating_sub(1) {
        let a = mono[i];
        let b = mono[i + 1];
        if a == 0.0 || (a < 0.0) != (b < 0.0) {
            let d = (i as i64 - target).abs();
            if best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, start + i as u64));
            }
        }
    }
    Ok(best.map_or(frame, |(_, f)| f))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_sine(path: &Path, frames: u32) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..frames {
            // 100 Hz sine: zero crossings every 240 frames at 48 kHz.
            let t = i as f32 / 48_000.0;
            w.write_sample((2.0 * std::f32::consts::PI * 100.0 * t).sin())
                .unwrap();
        }
        w.finalize().unwrap();
    }

    #[test]
    fn snaps_to_the_nearest_crossing_of_a_sine() {
        let dir = std::env::temp_dir().join("waver-zc-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sine.wav");
        write_sine(&path, 4_800);
        // Crossings at multiples of 240; frame 500 should snap to 480.
        let z = nearest_zero_crossing(&path, 500, 2_000).unwrap();
        assert!(
            (z as i64 - 480).unsigned_abs() <= 1,
            "expected ~480, got {z}"
        );
        // Frame 130 is nearer to 240 than 0.
        let z = nearest_zero_crossing(&path, 130, 2_000).unwrap();
        assert!((z as i64 - 240).unsigned_abs() <= 1 || z == 0, "got {z}");
    }
}
