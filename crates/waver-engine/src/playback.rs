//! Playback engine (spec FR-6.1 / FR-6.2).
//!
//! Mirrors the capture pipeline, reversed:
//!
//! ```text
//!  render thread ──mixed f32──▶ rtrb ring ──▶ cpal output callback ──▶ device
//!  (Mixer -> blocks)            (lock-free)   (pulls; counts played frames)
//! ```
//!
//! The **render thread** mixes ahead into the ring; the **output callback** pulls
//! from it (no allocation/locking/syscalls) and counts frames actually played so the
//! reported playhead tracks the audible output (FR-6.2), not the render head.

use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Sample, SampleFormat, StreamConfig};
use waver_core::engine::EngineError;
use waver_core::model::Project;

use crate::mixer::Mixer;

const RENDER_BLOCK: usize = 1024; // frames mixed per render iteration

/// A loop region on the timeline, in frames.
#[derive(Clone, Copy)]
pub struct LoopRegion {
    pub start: u64,
    pub end: u64,
}

/// A running playback session. Dropping it stops and joins the threads.
pub struct Playback {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    played: Arc<AtomicU64>,
    ended: Arc<AtomicBool>,
    start_frame: u64,
    loop_region: Option<LoopRegion>,
    output: Option<JoinHandle<()>>,
    render: Option<JoinHandle<()>>,
}

impl Playback {
    /// Current playhead position in project frames (tracks audible output).
    pub fn position(&self) -> u64 {
        let raw = self.start_frame + self.played.load(Ordering::Relaxed);
        match self.loop_region {
            Some(lr) if lr.end > lr.start && raw >= lr.start => {
                lr.start + (raw - lr.start) % (lr.end - lr.start)
            }
            _ => raw,
        }
    }

    pub fn is_playing(&self) -> bool {
        !self.ended.load(Ordering::Relaxed) && !self.stop.load(Ordering::Relaxed)
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.output.take() {
            h.thread().unpark();
            let _ = h.join();
        }
        if let Some(h) = self.render.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Playback {
    fn drop(&mut self) {
        self.stop();
    }
}

fn resolve_output_device(device_id: &str) -> Result<(cpal::Host, cpal::Device), EngineError> {
    let id = cpal::DeviceId::from_str(device_id)
        .map_err(|e| EngineError::DeviceNotFound(format!("{device_id}: {e}")))?;
    let host = cpal::host_from_id(id.host()).map_err(|e| EngineError::Backend(e.to_string()))?;
    let dev = host
        .device_by_id(&id)
        .ok_or_else(|| EngineError::DeviceNotFound(device_id.to_string()))?;
    Ok((host, dev))
}

/// Pick an output config for the requested rate, preferring a buildable format.
fn pick_output(dev: &cpal::Device, sample_rate: u32) -> Result<(SampleFormat, u16), EngineError> {
    let configs = dev
        .supported_output_configs()
        .map_err(|e| EngineError::Backend(e.to_string()))?;
    let mut best: Option<(SampleFormat, u16)> = None;
    for range in configs {
        if sample_rate >= range.min_sample_rate() && sample_rate <= range.max_sample_rate() {
            let fmt = range.sample_format();
            let buildable = matches!(
                fmt,
                SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16 | SampleFormat::I32
            );
            if buildable {
                // Prefer 2 channels (stereo) when available, else the smallest.
                let cand = (fmt, range.channels());
                best = Some(match best {
                    Some(cur) if cur.1 == 2 => cur,
                    _ => cand,
                });
            }
        }
    }
    best.ok_or_else(|| {
        EngineError::UnsupportedConfig(format!(
            "output device supports no config @ {sample_rate} Hz"
        ))
    })
}

/// Start playback of `project` on the output device from `start_frame`.
pub fn start(
    project: &Project,
    device_id: &str,
    start_frame: u64,
    loop_region: Option<LoopRegion>,
) -> Result<Playback, EngineError> {
    let sample_rate = project.sample_rate;
    let (_host, dev) = resolve_output_device(device_id)?;
    let (fmt, channels) = pick_output(&dev, sample_rate)?;

    let mixer = Arc::new(Mixer::new(project, channels)?);
    let total = mixer.total_frames();

    let stop = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let played = Arc::new(AtomicU64::new(0));
    let ended = Arc::new(AtomicBool::new(false));

    // Ring holds ~0.25 s of interleaved output samples.
    let ring_slots = (sample_rate as usize * channels as usize / 4).max(8192);
    let (mut producer, consumer) = rtrb::RingBuffer::<f32>::new(ring_slots);

    // Render thread: mix ahead into the ring.
    let render = {
        let stop = stop.clone();
        let paused = paused.clone();
        let ended = ended.clone();
        let mixer = mixer.clone();
        thread::Builder::new()
            .name("waver-render".into())
            .spawn(move || {
                let oc = channels as usize;
                let mut pos = start_frame;
                let mut block = vec![0.0f32; RENDER_BLOCK * oc];
                loop {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    if paused.load(Ordering::SeqCst) {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    // Reached the end (no loop): let the ring drain, then stop.
                    let at_end = loop_region.is_none() && pos >= total;
                    if at_end {
                        if consumer_is_empty(&producer, ring_slots) {
                            ended.store(true, Ordering::SeqCst);
                            break;
                        }
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    // Only push when there's room for a whole block.
                    if producer.slots() < block.len() {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    mixer.mix_into(&mut block, pos);
                    for &s in &block {
                        let _ = producer.push(s);
                    }
                    pos += RENDER_BLOCK as u64;
                    if let Some(lr) = loop_region {
                        if lr.end > lr.start && pos >= lr.end {
                            pos = lr.start;
                        }
                    }
                }
            })
            .map_err(|e| EngineError::Io(e.to_string()))?
    };

    // Output thread: owns the cpal stream; the callback pulls from the ring.
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), EngineError>>();
    let output = {
        let stop = stop.clone();
        let paused = paused.clone();
        let played = played.clone();
        thread::Builder::new()
            .name("waver-audio-output".into())
            .spawn(move || {
                let config = StreamConfig {
                    channels,
                    sample_rate,
                    buffer_size: BufferSize::Default,
                };
                let stream = match build_output_stream(
                    &dev, config, fmt, consumer, paused, played, channels,
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(EngineError::Backend(e.to_string())));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                while !stop.load(Ordering::SeqCst) {
                    thread::park_timeout(Duration::from_millis(100));
                }
                drop(stream);
            })
            .map_err(|e| EngineError::Io(e.to_string()))?
    };

    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            stop.store(true, Ordering::SeqCst);
            let _ = output.join();
            let _ = render.join();
            return Err(e);
        }
        Err(_) => {
            return Err(EngineError::Backend(
                "output thread exited before start".into(),
            ))
        }
    }

    Ok(Playback {
        stop,
        paused,
        played,
        ended,
        start_frame,
        loop_region,
        output: Some(output),
        render: Some(render),
    })
}

/// Whether the producer's ring is fully drained (all slots free).
fn consumer_is_empty(producer: &rtrb::Producer<f32>, capacity: usize) -> bool {
    producer.slots() >= capacity.saturating_sub(1)
}

#[allow(clippy::too_many_arguments)]
fn build_output_stream(
    dev: &cpal::Device,
    config: StreamConfig,
    fmt: SampleFormat,
    consumer: rtrb::Consumer<f32>,
    paused: Arc<AtomicBool>,
    played: Arc<AtomicU64>,
    channels: u16,
) -> Result<cpal::Stream, EngineError> {
    let oc = channels.max(1) as usize;
    macro_rules! build {
        ($t:ty) => {{
            let mut consumer = consumer;
            let paused = paused.clone();
            let played = played.clone();
            dev.build_output_stream::<$t, _, _>(
                config.clone(),
                move |data: &mut [$t], _: &cpal::OutputCallbackInfo| {
                    if paused.load(Ordering::Relaxed) {
                        for s in data.iter_mut() {
                            *s = <$t>::from_sample(0.0f32);
                        }
                        return;
                    }
                    let mut frames = 0u64;
                    for (i, out) in data.iter_mut().enumerate() {
                        match consumer.pop() {
                            Ok(v) => {
                                *out = <$t>::from_sample(v);
                                if i % oc == oc - 1 {
                                    frames += 1;
                                }
                            }
                            // Underrun: fill the rest with silence.
                            Err(_) => *out = <$t>::from_sample(0.0f32),
                        }
                    }
                    played.fetch_add(frames, Ordering::Relaxed);
                },
                move |_e| {},
                None,
            )
        }};
    }
    let stream = match fmt {
        SampleFormat::F32 => build!(f32),
        SampleFormat::I16 => build!(i16),
        SampleFormat::U16 => build!(u16),
        SampleFormat::I32 => build!(i32),
        other => {
            return Err(EngineError::UnsupportedConfig(format!(
                "unsupported output format {other:?}"
            )))
        }
    }
    .map_err(|e| EngineError::Backend(e.to_string()))?;
    Ok(stream)
}
