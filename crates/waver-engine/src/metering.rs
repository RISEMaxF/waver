//! Live input metering pipeline (spec FR-2.1).
//!
//! Thread architecture (keeps the cpal `Stream` off the `Send` path and the audio
//! callback realtime-safe, per §4.4):
//!
//! ```text
//!  cpal RT callback ──frame──▶ rtrb SPSC ring ──▶ emitter thread ──MeterUpdate──▶ sink
//!  (audio thread owns Stream)   (lock-free)         (~80 Hz drain)      (Tauri Channel)
//! ```
//!
//! - The **audio thread** builds and *owns* the cpal `Stream` (which is not reliably
//!   `Send` across platforms) and never moves it. Its callback only reduces the block
//!   to a fixed-size [`MeterFrame`] and pushes it into the ring — no alloc/lock/syscall.
//! - The **emitter thread** drains the ring every ~12 ms (>= 30 Hz), aggregates, and
//!   calls a generic `sink` — so this crate stays independent of Tauri.

use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleFormat, StreamConfig};
use waver_core::engine::{EngineError, MeterUpdate, StreamParams};

use crate::meter::{frame_from_interleaved, MeterAccumulator, MeterFrame};

/// Ring slots for meter frames. At a 512-frame buffer @ 48 kHz that is ~94 frames/s,
/// while the emitter drains at ~80 Hz — so this is generous headroom.
const RING_CAPACITY: usize = 512;

/// Emitter drain interval. Targets ~80 Hz so that even on platforms with coarse
/// sleep granularity (Windows' ~15.6 ms default timer) the effective rate stays
/// comfortably above the 30 Hz DoD.
const EMIT_INTERVAL: Duration = Duration::from_millis(12);

/// Handle to a running metering session. Dropping it stops and joins the threads.
pub struct MeterHandle {
    stop: Arc<AtomicBool>,
    device_lost: Arc<AtomicBool>,
    audio: Option<JoinHandle<()>>,
    emitter: Option<JoinHandle<()>>,
}

impl MeterHandle {
    /// Whether the input stream reported an error (e.g. device disconnected).
    pub fn device_lost(&self) -> bool {
        self.device_lost.load(Ordering::SeqCst)
    }

    /// Stop metering and join both threads. Idempotent.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.audio.take() {
            h.thread().unpark();
            let _ = h.join();
        }
        if let Some(h) = self.emitter.take() {
            let _ = h.join();
        }
    }
}

impl Drop for MeterHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Resolve a device id string (cpal `DeviceId` `Display` form) back to a live device.
fn resolve_input_device(device_id: &str) -> Result<(cpal::Host, cpal::Device), EngineError> {
    let id = cpal::DeviceId::from_str(device_id)
        .map_err(|e| EngineError::DeviceNotFound(format!("{device_id}: {e}")))?;
    let host = cpal::host_from_id(id.host()).map_err(|e| EngineError::Backend(e.to_string()))?;
    let dev = host
        .device_by_id(&id)
        .ok_or_else(|| EngineError::DeviceNotFound(device_id.to_string()))?;
    Ok((host, dev))
}

/// Choose the device sample format for the requested channels+rate, rejecting
/// unsupported combinations with a clear message (spec FR-1.3) rather than panicking.
fn pick_input_format(
    dev: &cpal::Device,
    params: &StreamParams,
) -> Result<SampleFormat, EngineError> {
    let configs = dev
        .supported_input_configs()
        .map_err(|e| EngineError::Backend(e.to_string()))?;

    // Collect ALL formats the device supports at the requested channels+rate. A
    // device (esp. ALSA/WASAPI) commonly exposes the same channels+rate under
    // several formats, and the backend may list them in an order where an
    // unbuildable one (e.g. I24) comes first — so we must scan them all and pick a
    // format our builder can actually handle, rather than taking the first match.
    let mut available: Vec<SampleFormat> = Vec::new();
    for range in configs {
        if range.channels() == params.channels
            && params.sample_rate >= range.min_sample_rate()
            && params.sample_rate <= range.max_sample_rate()
        {
            available.push(range.sample_format());
        }
    }

    if available.is_empty() {
        return Err(EngineError::UnsupportedConfig(format!(
            "device supports no input config for {} channel(s) @ {} Hz",
            params.channels, params.sample_rate
        )));
    }

    // Preference: native float first, then wider/int formats. All are buildable.
    const PREFERENCE: &[SampleFormat] = &[
        SampleFormat::F32,
        SampleFormat::I16,
        SampleFormat::I32,
        SampleFormat::I24,
        SampleFormat::U16,
        SampleFormat::F64,
        SampleFormat::U24,
        SampleFormat::I8,
        SampleFormat::U8,
    ];
    if let Some(&fmt) = PREFERENCE.iter().find(|f| available.contains(f)) {
        return Ok(fmt);
    }

    Err(EngineError::UnsupportedConfig(format!(
        "device only offers unsupported sample format(s) {available:?} for {} channel(s) @ {} Hz",
        params.channels, params.sample_rate
    )))
}

/// Build an input stream whose callback pushes [`MeterFrame`]s into `producer`. The
/// callback is realtime-safe; on stream error the `device_lost` flag is set.
fn build_metered_stream(
    dev: &cpal::Device,
    config: StreamConfig,
    fmt: SampleFormat,
    producer: rtrb::Producer<MeterFrame>,
    device_lost: Arc<AtomicBool>,
) -> Result<cpal::Stream, EngineError> {
    let channels = config.channels as usize;

    macro_rules! build {
        ($t:ty) => {{
            let mut producer = producer;
            let device_lost = device_lost.clone();
            dev.build_input_stream::<$t, _, _>(
                config.clone(),
                move |data: &[$t], _: &cpal::InputCallbackInfo| {
                    // Realtime-safe: fixed-size reduction, non-blocking push, drop on full.
                    let frame = frame_from_interleaved(data, channels);
                    let _ = producer.push(frame);
                },
                move |_e| {
                    device_lost.store(true, Ordering::SeqCst);
                },
                None,
            )
        }};
    }

    let stream = match fmt {
        SampleFormat::F32 => build!(f32),
        SampleFormat::F64 => build!(f64),
        SampleFormat::I16 => build!(i16),
        SampleFormat::I24 => build!(cpal::I24),
        SampleFormat::I32 => build!(i32),
        SampleFormat::I8 => build!(i8),
        SampleFormat::U8 => build!(u8),
        SampleFormat::U16 => build!(u16),
        SampleFormat::U24 => build!(cpal::U24),
        other => {
            return Err(EngineError::UnsupportedConfig(format!(
                "unsupported sample format {other:?}"
            )))
        }
    }
    .map_err(|e| EngineError::Backend(e.to_string()))?;

    Ok(stream)
}

/// Start live input metering. Returns once the stream is confirmed running (or an
/// error if it could not start). `sink` is invoked ~50 times/second with a
/// [`MeterUpdate`]; it must be cheap and non-blocking (e.g. a Tauri Channel send).
pub fn start_metering<S>(
    device_id: &str,
    params: StreamParams,
    sink: S,
) -> Result<MeterHandle, EngineError>
where
    S: Fn(MeterUpdate) + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let device_lost = Arc::new(AtomicBool::new(false));
    // The audio thread creates the ring (once per build attempt) and hands the
    // consumer back so the emitter can be spawned here.
    let (ready_tx, ready_rx) = mpsc::channel::<Result<rtrb::Consumer<MeterFrame>, EngineError>>();

    // Audio thread: builds and owns the cpal Stream; never moves it across threads.
    let audio = {
        let device_id = device_id.to_string();
        let stop = stop.clone();
        let device_lost = device_lost.clone();
        thread::Builder::new()
            .name("waver-audio-input".into())
            .spawn(move || {
                // `_host` is kept in scope (not dropped early) so the device stays
                // valid for the lifetime of the stream.
                let (_host, dev) = match resolve_input_device(&device_id) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                let fmt = match pick_input_format(&dev, &params) {
                    Ok(f) => f,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };

                // Try the requested buffer size; if a *fixed* size was asked for and
                // the backend rejects it (common on WASAPI/ALSA), fall back to the
                // backend default rather than failing to meter (spec FR-1.3).
                let buffer_attempts: Vec<BufferSize> = match params.buffer_frames {
                    Some(n) => vec![BufferSize::Fixed(n), BufferSize::Default],
                    None => vec![BufferSize::Default],
                };
                let mut built: Option<(cpal::Stream, rtrb::Consumer<MeterFrame>)> = None;
                let mut last_err: Option<EngineError> = None;
                for buffer_size in buffer_attempts {
                    // Fresh ring per attempt: a failed build consumes its producer.
                    let (producer, consumer) = rtrb::RingBuffer::<MeterFrame>::new(RING_CAPACITY);
                    let config = StreamConfig {
                        channels: params.channels,
                        sample_rate: params.sample_rate,
                        buffer_size,
                    };
                    match build_metered_stream(&dev, config, fmt, producer, device_lost.clone()) {
                        Ok(stream) => {
                            built = Some((stream, consumer));
                            break;
                        }
                        Err(e) => last_err = Some(e),
                    }
                }
                let (stream, consumer) = match built {
                    Some(v) => v,
                    None => {
                        let _ = ready_tx.send(Err(last_err.unwrap_or_else(|| {
                            EngineError::Backend("failed to build input stream".into())
                        })));
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(EngineError::Backend(e.to_string())));
                    return;
                }
                let _ = ready_tx.send(Ok(consumer));

                // Keep the stream alive until asked to stop OR the device is lost
                // (so a disconnect tears the stream/thread down instead of lingering).
                while !stop.load(Ordering::SeqCst) && !device_lost.load(Ordering::SeqCst) {
                    thread::park_timeout(Duration::from_millis(100));
                }
                // Explicitly stop the stream first; `dev`/`_host` then drop at scope end.
                drop(stream);
            })
            .map_err(|e| EngineError::Io(e.to_string()))?
    };

    // Wait for the stream to confirm it started (propagates build/config errors) and
    // to receive the ring consumer for the emitter.
    let consumer = match ready_rx.recv() {
        Ok(Ok(consumer)) => consumer,
        Ok(Err(e)) => {
            stop.store(true, Ordering::SeqCst);
            let _ = audio.join();
            return Err(e);
        }
        Err(_) => {
            return Err(EngineError::Backend(
                "audio thread exited before start".into(),
            ))
        }
    };

    // Emitter thread: drains the ring at >= 30 Hz and pushes updates to the sink.
    let emitter = {
        let stop = stop.clone();
        let device_lost = device_lost.clone();
        let mut consumer = consumer;
        thread::Builder::new()
            .name("waver-meter-emit".into())
            .spawn(move || {
                let mut acc = MeterAccumulator::new();
                while !stop.load(Ordering::SeqCst) && !device_lost.load(Ordering::SeqCst) {
                    thread::sleep(EMIT_INTERVAL);
                    while let Ok(frame) = consumer.pop() {
                        acc.add(&frame);
                    }
                    if acc.has_data() {
                        sink(acc.drain_to_update());
                    }
                }
            })
    };
    let emitter = match emitter {
        Ok(h) => h,
        Err(e) => {
            // Tear down the already-running audio thread before bailing out.
            stop.store(true, Ordering::SeqCst);
            audio.thread().unpark();
            let _ = audio.join();
            return Err(EngineError::Io(e.to_string()));
        }
    };

    Ok(MeterHandle {
        stop,
        device_lost,
        audio: Some(audio),
        emitter: Some(emitter),
    })
}
