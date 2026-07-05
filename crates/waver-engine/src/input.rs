//! Live input pipeline: metering (FR-2.1) + clean capture to disk (FR-2.2/2.3/2.4).
//!
//! Thread architecture (spec §4.4 realtime safety):
//!
//! ```text
//!  cpal RT callback ──raw f32──▶ rtrb SPSC ring ──▶ consumer thread ─┬─▶ meter sink (Tauri Channel)
//!  (audio thread owns Stream)    (lock-free)        (~80 Hz drain)   └─▶ WavRecorder (when recording)
//! ```
//!
//! - The **audio thread** builds and owns the cpal `Stream`. Its callback does the
//!   minimum: convert each sample to f32 (lossless) and push it into the ring. No
//!   heap alloc, no locking, no syscalls, no logging.
//! - The **consumer thread** (non-realtime) drains the ring, computes peak/RMS for
//!   the meter, and — when a recording is active — streams the raw samples to a
//!   32-bit float WAV. Disk I/O never touches the audio callback.

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Sample, SampleFormat, StreamConfig};
use waver_core::engine::{EngineError, MeterUpdate, StreamParams};

use crate::capture::{RecordingInfo, WavRecorder};
use crate::meter::{frame_from_interleaved, MeterAccumulator};

/// Ring capacity, in seconds of audio. Sized so a transient disk stall does not
/// overrun (drop capture samples) before the consumer catches up.
const RING_SECONDS: usize = 2;
const RING_MIN_SLOTS: usize = 8192;

/// Consumer drain / meter-emit interval. ~80 Hz — well above the 30 Hz meter DoD.
const EMIT_INTERVAL: Duration = Duration::from_millis(12);

/// Commands sent to the consumer thread to toggle recording.
enum RecCmd {
    Start {
        path: PathBuf,
        reply: mpsc::Sender<Result<(), EngineError>>,
    },
    Stop {
        reply: mpsc::Sender<Result<RecordingInfo, EngineError>>,
    },
}

/// A live input session: metering runs for its whole lifetime; recording can be
/// started/stopped on it. Dropping the session stops everything and joins threads.
pub struct InputSession {
    stop: Arc<AtomicBool>,
    device_lost: Arc<AtomicBool>,
    xrun: Arc<AtomicBool>,
    rec_tx: mpsc::Sender<RecCmd>,
    audio: Option<JoinHandle<()>>,
    consumer: Option<JoinHandle<()>>,
}

impl InputSession {
    /// Whether the input stream reported an error (e.g. device disconnected).
    pub fn device_lost(&self) -> bool {
        self.device_lost.load(Ordering::SeqCst)
    }

    /// Whether the capture ring overran (dropped samples) since opening.
    pub fn had_xrun(&self) -> bool {
        self.xrun.load(Ordering::SeqCst)
    }

    /// Start recording to `path` (32-bit float WAV). Errors if already recording or
    /// the file cannot be created.
    pub fn start_recording(&self, path: PathBuf) -> Result<(), EngineError> {
        let (tx, rx) = mpsc::channel();
        self.rec_tx
            .send(RecCmd::Start { path, reply: tx })
            .map_err(|_| EngineError::Backend("input session closed".into()))?;
        rx.recv()
            .map_err(|_| EngineError::Backend("recorder did not reply".into()))?
    }

    /// Stop recording and finalize the WAV, returning its metadata.
    pub fn stop_recording(&self) -> Result<RecordingInfo, EngineError> {
        let (tx, rx) = mpsc::channel();
        self.rec_tx
            .send(RecCmd::Stop { reply: tx })
            .map_err(|_| EngineError::Backend("input session closed".into()))?;
        rx.recv()
            .map_err(|_| EngineError::Backend("recorder did not reply".into()))?
    }

    /// Stop the session and join its threads. Idempotent.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.audio.take() {
            h.thread().unpark();
            let _ = h.join();
        }
        if let Some(h) = self.consumer.take() {
            let _ = h.join();
        }
    }
}

impl Drop for InputSession {
    fn drop(&mut self) {
        self.stop();
    }
}

fn resolve_input_device(device_id: &str) -> Result<(cpal::Host, cpal::Device), EngineError> {
    let id = cpal::DeviceId::from_str(device_id)
        .map_err(|e| EngineError::DeviceNotFound(format!("{device_id}: {e}")))?;
    let host = cpal::host_from_id(id.host()).map_err(|e| EngineError::Backend(e.to_string()))?;
    let dev = host
        .device_by_id(&id)
        .ok_or_else(|| EngineError::DeviceNotFound(device_id.to_string()))?;
    Ok((host, dev))
}

/// Choose a *buildable* device sample format for the requested channels+rate,
/// rejecting unsupported combinations with a clear message (no panic; spec FR-1.3).
fn pick_input_format(
    dev: &cpal::Device,
    params: &StreamParams,
) -> Result<SampleFormat, EngineError> {
    let configs = dev
        .supported_input_configs()
        .map_err(|e| EngineError::Backend(e.to_string()))?;
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
    // Prefer float, then wider/int formats — all buildable below.
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
    PREFERENCE
        .iter()
        .find(|f| available.contains(f))
        .copied()
        .ok_or_else(|| {
            EngineError::UnsupportedConfig(format!(
                "device only offers unsupported sample format(s) {available:?} for {} ch @ {} Hz",
                params.channels, params.sample_rate
            ))
        })
}

/// Build an input stream whose callback converts each sample to f32 and pushes it
/// into `producer`. Realtime-safe: no alloc/lock/syscall/log. On stream error the
/// `device_lost` flag is set; on ring overrun the `xrun` flag is set.
fn build_input_stream(
    dev: &cpal::Device,
    config: StreamConfig,
    fmt: SampleFormat,
    producer: rtrb::Producer<f32>,
    device_lost: Arc<AtomicBool>,
    xrun: Arc<AtomicBool>,
) -> Result<cpal::Stream, EngineError> {
    macro_rules! build {
        ($t:ty) => {{
            let mut producer = producer;
            let device_lost = device_lost.clone();
            let xrun = xrun.clone();
            dev.build_input_stream::<$t, _, _>(
                config.clone(),
                move |data: &[$t], _: &cpal::InputCallbackInfo| {
                    for &sample in data {
                        let s: f32 = f32::from_sample(sample);
                        if producer.push(s).is_err() {
                            xrun.store(true, Ordering::Relaxed);
                            break; // ring full: drop the rest of this block
                        }
                    }
                },
                move |_e| device_lost.store(true, Ordering::SeqCst),
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

/// Open a live input session: start the stream + metering, ready for recording.
/// `meter_sink` is called ~80 Hz with a [`MeterUpdate`].
pub fn open<S>(
    device_id: &str,
    params: StreamParams,
    meter_sink: S,
) -> Result<InputSession, EngineError>
where
    S: Fn(MeterUpdate) + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let device_lost = Arc::new(AtomicBool::new(false));
    let xrun = Arc::new(AtomicBool::new(false));
    let channels = params.channels.max(1) as usize;
    let ring_slots = (params.sample_rate as usize * channels * RING_SECONDS).max(RING_MIN_SLOTS);
    let (ready_tx, ready_rx) = mpsc::channel::<Result<rtrb::Consumer<f32>, EngineError>>();

    // Audio thread: owns the cpal Stream; never moves it across threads.
    let audio = {
        let device_id = device_id.to_string();
        let stop = stop.clone();
        let device_lost = device_lost.clone();
        let xrun = xrun.clone();
        thread::Builder::new()
            .name("waver-audio-input".into())
            .spawn(move || {
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

                // Try the requested buffer; if a fixed size is rejected (common on
                // WASAPI/ALSA), fall back to the backend default (spec FR-1.3).
                let attempts: Vec<BufferSize> = match params.buffer_frames {
                    Some(n) => vec![BufferSize::Fixed(n), BufferSize::Default],
                    None => vec![BufferSize::Default],
                };
                let mut built: Option<(cpal::Stream, rtrb::Consumer<f32>)> = None;
                let mut last_err = None;
                for buffer_size in attempts {
                    let (producer, consumer) = rtrb::RingBuffer::<f32>::new(ring_slots);
                    let config = StreamConfig {
                        channels: params.channels,
                        sample_rate: params.sample_rate,
                        buffer_size,
                    };
                    match build_input_stream(
                        &dev,
                        config,
                        fmt,
                        producer,
                        device_lost.clone(),
                        xrun.clone(),
                    ) {
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

                while !stop.load(Ordering::SeqCst) && !device_lost.load(Ordering::SeqCst) {
                    thread::park_timeout(Duration::from_millis(100));
                }
                drop(stream);
            })
            .map_err(|e| EngineError::Io(e.to_string()))?
    };

    let consumer_ring = match ready_rx.recv() {
        Ok(Ok(c)) => c,
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

    let (rec_tx, rec_rx) = mpsc::channel::<RecCmd>();

    // Consumer thread: drain -> meter + (optional) record.
    let stop_teardown = stop.clone();
    let consumer = {
        let stop = stop.clone();
        let device_lost = device_lost.clone();
        let mut ring = consumer_ring;
        let chans = params.channels.max(1) as usize;
        let sample_rate = params.sample_rate;
        let sink = meter_sink;
        let build_result = thread::Builder::new()
            .name("waver-input-consumer".into())
            .spawn(move || {
                let mut acc = MeterAccumulator::new();
                let mut scratch: Vec<f32> = Vec::with_capacity(ring_slots);
                let mut recorder: Option<WavRecorder> = None;
                let mut rec_error: Option<EngineError> = None;

                while !stop.load(Ordering::SeqCst) && !device_lost.load(Ordering::SeqCst) {
                    // Handle recording control commands.
                    while let Ok(cmd) = rec_rx.try_recv() {
                        match cmd {
                            RecCmd::Start { path, reply } => {
                                let r = WavRecorder::create(&path, params.channels, sample_rate);
                                match r {
                                    Ok(w) => {
                                        recorder = Some(w);
                                        rec_error = None;
                                        let _ = reply.send(Ok(()));
                                    }
                                    Err(e) => {
                                        let _ = reply.send(Err(e));
                                    }
                                }
                            }
                            RecCmd::Stop { reply } => {
                                let result = match recorder.take() {
                                    Some(w) => {
                                        if let Some(e) = rec_error.take() {
                                            // Finalize whatever we have, but report the error.
                                            let _ = w.finalize();
                                            Err(e)
                                        } else {
                                            w.finalize()
                                        }
                                    }
                                    None => Err(EngineError::NotCapturing),
                                };
                                let _ = reply.send(result);
                            }
                        }
                    }

                    thread::sleep(EMIT_INTERVAL);

                    scratch.clear();
                    while let Ok(s) = ring.pop() {
                        scratch.push(s);
                    }
                    if !scratch.is_empty() {
                        acc.add(&frame_from_interleaved(&scratch, chans));
                        if let Some(w) = recorder.as_mut() {
                            if let Err(e) = w.write_interleaved(&scratch) {
                                rec_error = Some(e);
                                // Stop writing further; keep the recorder to finalize on Stop.
                            }
                        }
                    }
                    if acc.has_data() {
                        sink(acc.drain_to_update());
                    }
                }

                // Session ending: finalize any in-flight recording so the file is valid.
                if let Some(w) = recorder.take() {
                    let _ = w.finalize();
                }
            });
        match build_result {
            Ok(h) => h,
            Err(e) => {
                stop_teardown.store(true, Ordering::SeqCst);
                audio.thread().unpark();
                let _ = audio.join();
                return Err(EngineError::Io(e.to_string()));
            }
        }
    };

    Ok(InputSession {
        stop,
        device_lost,
        xrun,
        rec_tx,
        audio: Some(audio),
        consumer: Some(consumer),
    })
}
