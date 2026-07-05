//! Live metering integration test (spec FR-2.1). Requires a real input device and,
//! on macOS, microphone permission — so it is `#[ignore]`d and excluded from CI.
//! Run manually with:
//!
//! ```sh
//! cargo test -p waver-engine --test metering_live -- --ignored --nocapture
//! ```

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use waver_core::engine::{DeviceDirection, StreamParams};
use waver_engine::{enumerate_devices, start_metering};

#[test]
#[ignore = "requires a real input device + mic permission"]
fn meters_default_input_at_30hz() {
    let input = enumerate_devices()
        .into_iter()
        .find(|d| d.direction == DeviceDirection::Input && d.is_default)
        .or_else(|| {
            enumerate_devices()
                .into_iter()
                .find(|d| d.direction == DeviceDirection::Input)
        })
        .expect("no input device available");

    println!("metering device: {} ({})", input.name, input.id);
    let sample_rate = input
        .sample_rates
        .iter()
        .copied()
        .find(|&r| r == 48_000)
        .unwrap_or(
            *input
                .sample_rates
                .first()
                .expect("device reports no sample rates"),
        );
    let channels = *input
        .channels
        .first()
        .expect("device reports no channel counts");

    let params = StreamParams {
        sample_rate,
        channels,
        buffer_frames: None,
    };

    let count = Arc::new(AtomicUsize::new(0));
    let count2 = count.clone();
    let last = Arc::new(std::sync::Mutex::new(None::<f32>));
    let last2 = last.clone();

    let handle = start_metering(&input.id, params, move |update| {
        count2.fetch_add(1, Ordering::SeqCst);
        if let Some(ch0) = update.channels.first() {
            *last2.lock().unwrap() = Some(ch0.peak_dbfs);
        }
    })
    .expect("start_metering failed");

    let start = Instant::now();
    std::thread::sleep(Duration::from_secs(1));
    drop(handle);

    let n = count.load(Ordering::SeqCst);
    let hz = n as f64 / start.elapsed().as_secs_f64();
    println!(
        "received {n} meter updates in ~1s (~{hz:.0} Hz), last peak = {:?} dBFS",
        *last.lock().unwrap()
    );
    assert!(hz >= 30.0, "meter update rate {hz:.1} Hz below 30 Hz DoD");
}
