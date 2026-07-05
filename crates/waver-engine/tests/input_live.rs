//! Live input integration tests (spec FR-2.1 / FR-2.2). Require a real input device
//! and, on macOS, microphone permission — so they are `#[ignore]`d and excluded
//! from CI. Run manually with:
//!
//! ```sh
//! cargo test -p waver-engine --test input_live -- --ignored --nocapture
//! ```

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use waver_core::engine::{DeviceDirection, StreamParams};
use waver_engine::{enumerate_devices, open_input};

fn default_input_params() -> (String, StreamParams) {
    let input = enumerate_devices()
        .into_iter()
        .find(|d| d.direction == DeviceDirection::Input && d.is_default)
        .or_else(|| {
            enumerate_devices()
                .into_iter()
                .find(|d| d.direction == DeviceDirection::Input)
        })
        .expect("no input device available");
    let sample_rate = input
        .sample_rates
        .iter()
        .copied()
        .find(|&r| r == 48_000)
        .unwrap_or_else(|| *input.sample_rates.first().expect("no sample rates"));
    let channels = *input.channels.first().expect("no channel counts");
    (
        input.id,
        StreamParams {
            sample_rate,
            channels,
            buffer_frames: None,
        },
    )
}

#[test]
#[ignore = "requires a real input device + mic permission"]
fn meters_default_input_at_30hz() {
    let (id, params) = default_input_params();
    let count = Arc::new(AtomicUsize::new(0));
    let count2 = count.clone();

    let session = open_input(&id, params, move |_u| {
        count2.fetch_add(1, Ordering::SeqCst);
    })
    .expect("open_input failed");

    let start = Instant::now();
    std::thread::sleep(Duration::from_secs(1));
    drop(session);

    let hz = count.load(Ordering::SeqCst) as f64 / start.elapsed().as_secs_f64();
    println!("meter rate ~{hz:.0} Hz");
    assert!(hz >= 30.0, "meter rate {hz:.1} Hz below 30 Hz DoD");
}

#[test]
#[ignore = "requires a real input device + mic permission"]
fn records_a_valid_wav() {
    let (id, params) = default_input_params();
    let session = open_input(&id, params, |_u| {}).expect("open_input failed");

    let path = std::env::temp_dir().join("waver_live_take.wav");
    let _ = std::fs::remove_file(&path);
    session
        .start_recording(path.clone())
        .expect("start_recording");
    std::thread::sleep(Duration::from_millis(600));
    let info = session.stop_recording().expect("stop_recording");
    drop(session);

    println!(
        "recorded {} frames, {} ch @ {} Hz -> {}",
        info.frames,
        info.channels,
        info.sample_rate,
        info.path.display()
    );
    assert!(info.frames > 0, "no frames recorded");

    // The file must open in a reference reader with the right format.
    let reader = hound::WavReader::open(&path).expect("open recorded wav");
    let spec = reader.spec();
    assert_eq!(spec.channels, params.channels);
    assert_eq!(spec.sample_rate, params.sample_rate);
    assert_eq!(spec.bits_per_sample, 32);
    assert_eq!(spec.sample_format, hound::SampleFormat::Float);
    assert_eq!(reader.duration() as u64, info.frames);
    let _ = std::fs::remove_file(&path);
}
