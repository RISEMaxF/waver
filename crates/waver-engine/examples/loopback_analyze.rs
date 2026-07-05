//! FR-2.3 loopback fidelity analyzer.
//!
//! Compares a reference WAV against a WAV recorded via an analog loopback (interface
//! out -> interface in). Finds the alignment lag by cross-correlation, then reports
//! the correlation and level match at that lag.
//!
//! Usage:
//!   cargo run -p waver-engine --example loopback_analyze -- <reference.wav> <recorded.wav>
//!
//! Interpretation: a clean capture path (no DSP) should yield correlation >= 0.999
//! and a level difference within a fraction of a dB. Analog converter noise/offset
//! sets the practical ceiling; large deviations indicate the software added gain,
//! filtering, or resampling.

fn read_mono(path: &str) -> (u32, Vec<f32>) {
    let mut reader = hound::WavReader::open(path).unwrap_or_else(|e| panic!("open {path}: {e}"));
    let spec = reader.spec();
    let ch = spec.channels.max(1) as usize;
    // Collect samples as f32 regardless of the file's storage format.
    let all: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
        hound::SampleFormat::Int => {
            let max = (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.unwrap() as f32 / max)
                .collect()
        }
    };
    // Downmix to channel 0 (first channel) for alignment.
    let mono: Vec<f32> = all.iter().step_by(ch).copied().collect();
    (spec.sample_rate, mono)
}

fn rms(x: &[f32]) -> f64 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / x.len() as f64).sqrt()
}

/// Normalized cross-correlation of `a` against `b` at integer lags in [-max, max].
/// Returns (best_lag, best_normalized_correlation).
fn best_lag(a: &[f32], b: &[f32], max_lag: i64) -> (i64, f64) {
    let n = a.len().min(b.len());
    // Use a central window of `a` to keep the search cheap.
    let win = n.min(48_000); // ~1s at 48k
    let start = (n - win) / 2;
    let aw = &a[start..start + win];
    let a_energy = aw.iter().map(|&s| (s as f64).powi(2)).sum::<f64>().sqrt();

    let mut best = (0i64, -1.0f64);
    for lag in -max_lag..=max_lag {
        let mut dot = 0.0f64;
        let mut b_energy = 0.0f64;
        for (i, &av) in aw.iter().enumerate() {
            let bi = start as i64 + i as i64 + lag;
            if bi < 0 || bi as usize >= b.len() {
                continue;
            }
            let bv = b[bi as usize] as f64;
            dot += av as f64 * bv;
            b_energy += bv * bv;
        }
        let denom = a_energy * b_energy.sqrt();
        let corr = if denom > 0.0 { dot / denom } else { 0.0 };
        if corr > best.1 {
            best = (lag, corr);
        }
    }
    best
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: loopback_analyze <reference.wav> <recorded.wav>");
        std::process::exit(2);
    }
    let (sr_a, a) = read_mono(&args[1]);
    let (sr_b, b) = read_mono(&args[2]);
    if sr_a != sr_b {
        eprintln!("warning: sample rates differ ({sr_a} vs {sr_b}); comparison may be invalid");
    }

    let (lag, corr) = best_lag(&a, &b, sr_a as i64); // search +-1s
    let level_db = 20.0 * (rms(&b) / rms(&a).max(1e-12)).log10();

    println!("reference: {} samples @ {sr_a} Hz", a.len());
    println!("recorded:  {} samples @ {sr_b} Hz", b.len());
    println!(
        "best alignment lag: {lag} samples ({:.2} ms)",
        lag as f64 * 1000.0 / sr_a as f64
    );
    println!("cross-correlation at lag: {corr:.6}");
    println!("level difference (recorded - reference): {level_db:+.3} dB");

    let corr_ok = corr >= 0.999;
    let level_ok = level_db.abs() <= 0.5;
    if corr_ok && level_ok {
        println!("\nPASS: capture is faithful (corr >= 0.999, |level| <= 0.5 dB)");
    } else {
        println!(
            "\nCHECK: corr_ok={corr_ok} level_ok={level_ok} — investigate if the software path (not the analog converters) is responsible"
        );
    }
}
