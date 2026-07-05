//! Live playback integration test (spec FR-6.1/6.2). Requires a real output device,
//! so it is `#[ignore]`d and excluded from CI. Run manually with:
//!
//! ```sh
//! cargo test -p waver-engine --test playback_live -- --ignored --nocapture
//! ```

use std::time::Duration;

use waver_core::engine::DeviceDirection;
use waver_core::model::{Clip, Project, Source, Track};
use waver_engine::{enumerate_devices, start_playback, WavRecorder};

#[test]
#[ignore = "requires a real output device"]
fn plays_and_advances_position() {
    // Write a 2-second 220 Hz tone at -12 dBFS to a temp WAV.
    let path = std::env::temp_dir().join("waver_playback_tone.wav");
    let sr = 48_000u32;
    let frames = (sr * 2) as usize;
    let amp = 10f32.powf(-12.0 / 20.0);
    let mut rec = WavRecorder::create(&path, 1, sr).unwrap();
    let tone: Vec<f32> = (0..frames)
        .map(|i| amp * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / sr as f32).sin())
        .collect();
    rec.write_interleaved(&tone).unwrap();
    rec.finalize().unwrap();

    // Build a project with that source as a clip on one track.
    let src = Source::new(path.clone(), 1, sr, frames as u64);
    let mut project = Project::new(sr);
    project.sources.push(src.clone());
    let mut track = Track::new("A");
    track.clips.push(Clip::new(&src, 0));
    project.tracks.push(track);

    let output = enumerate_devices()
        .into_iter()
        .find(|d| d.direction == DeviceDirection::Output && d.is_default)
        .or_else(|| {
            enumerate_devices()
                .into_iter()
                .find(|d| d.direction == DeviceDirection::Output)
        })
        .expect("no output device");
    println!("playing on {} ({})", output.name, output.id);

    let pb = start_playback(&project, &output.id, 0, None).expect("start_playback");
    std::thread::sleep(Duration::from_millis(400));
    let pos = pb.position();
    println!(
        "position after ~400ms: {pos} frames ({:.2}s)",
        pos as f64 / sr as f64
    );
    assert!(pos > 0, "playhead did not advance (pos={pos})");
    assert!(
        pb.is_playing(),
        "should still be playing at 0.4s of a 2s tone"
    );
    drop(pb);
    let _ = std::fs::remove_file(&path);
}
