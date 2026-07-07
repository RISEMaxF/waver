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
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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

/// Playback speed: `rate` source frames consumed per output frame (clamped to
/// 0.25..=4.0). `preserve_pitch` selects WSOLA time-stretch; otherwise varispeed
/// (tape-style repitch via linear-interpolation resampling).
#[derive(Debug, Clone, Copy)]
pub struct SpeedSpec {
    pub rate: f64,
    pub preserve_pitch: bool,
}

impl Default for SpeedSpec {
    fn default() -> Self {
        Self {
            rate: 1.0,
            preserve_pitch: false,
        }
    }
}

/// WSOLA time-stretcher: 50% Hann overlap-add of windows fetched near the nominal
/// (speed-scaled) position, each aligned by cross-correlation with the natural
/// continuation of the previous window - pitch stays put, timing scales.
struct Wsola {
    oc: usize,
    rate: f64,
    win: usize,
    hop: usize,
    search: usize,
    cmp: usize,
    hann: Vec<f32>,
    /// OLA accumulator (win frames); the first `hop` are complete after each step.
    acc: Vec<f32>,
    /// Where seamless audio would continue from the last chosen window.
    natural_next: f64,
    /// Speed-scaled analysis position (this is the UI-visible source position).
    next_nominal: f64,
    seg: Vec<f32>,
    refbuf: Vec<f32>,
}

impl Wsola {
    fn new(mixer: &Mixer, oc: usize, rate: f64, start: f64) -> Self {
        let win = 2048usize;
        let hop = win / 2;
        let hann: Vec<f32> = (0..win)
            .map(|i| {
                let x = std::f32::consts::PI * i as f32 / win as f32;
                x.sin() * x.sin()
            })
            .collect();
        let mut w = Self {
            oc,
            rate,
            win,
            hop,
            search: 512,
            cmp: 512,
            hann,
            acc: vec![0.0; win * oc],
            natural_next: 0.0,
            next_nominal: 0.0,
            seg: Vec::new(),
            refbuf: Vec::new(),
        };
        // Prime one unsearched window so the first emitted hop has both OLA halves
        // (no fade-in at play start).
        Self::fetch(mixer, &mut w.seg, oc, start, win);
        for i in 0..win {
            let g = w.hann[i];
            for c in 0..oc {
                w.acc[i * oc + c] += w.seg[i * oc + c] * g;
            }
        }
        w.natural_next = start + hop as f64;
        w.next_nominal = start + hop as f64 * rate;
        w
    }

    fn fetch(mixer: &Mixer, buf: &mut Vec<f32>, oc: usize, pos: f64, frames: usize) {
        buf.resize(frames * oc, 0.0);
        mixer.mix_into(buf, pos.max(0.0) as u64);
    }

    /// Produce `hop` output frames into `out` (appended), consuming `hop * rate`
    /// source frames.
    fn step(&mut self, mixer: &Mixer, out: &mut Vec<f32>) {
        let oc = self.oc;
        let region = self.win + 2 * self.search;
        let base = (self.next_nominal - self.search as f64).max(0.0);
        let mut seg = std::mem::take(&mut self.seg);
        let mut refbuf = std::mem::take(&mut self.refbuf);
        Self::fetch(mixer, &mut seg, oc, base, region);
        Self::fetch(mixer, &mut refbuf, oc, self.natural_next, self.cmp);

        // Correlate mono folds (stride 4 keeps this cheap at 80+ candidates).
        let mono = |b: &[f32], i: usize| {
            let mut acc = 0.0f32;
            for c in 0..oc {
                acc += b[i * oc + c];
            }
            acc
        };
        let mut best = self.search; // unbiased default: the nominal position
        let mut best_score = f32::NEG_INFINITY;
        for off in 0..=(2 * self.search) {
            let mut score = 0.0f32;
            let mut i = 0;
            while i < self.cmp {
                score += mono(&seg, off + i) * mono(&refbuf, i);
                i += 4;
            }
            if score > best_score {
                best_score = score;
                best = off;
            }
        }

        // OLA the chosen window; the accumulator's first `hop` frames are now final.
        for i in 0..self.win {
            let g = self.hann[i];
            for c in 0..oc {
                self.acc[i * oc + c] += seg[(best + i) * oc + c] * g;
            }
        }
        out.extend_from_slice(&self.acc[..self.hop * oc]);
        self.acc.copy_within(self.hop * oc.., 0);
        let tail = (self.win - self.hop) * oc;
        for v in &mut self.acc[tail..] {
            *v = 0.0;
        }

        self.natural_next = base + best as f64 + self.hop as f64;
        self.next_nominal += self.hop as f64 * self.rate;
        self.seg = seg;
        self.refbuf = refbuf;
    }
}

/// A running playback session. Dropping it stops and joins the threads.
pub struct Playback {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    played: Arc<AtomicU64>,
    ended: Arc<AtomicBool>,
    /// Per-channel output peak (abs, f32 bits) since the last `take_levels` — written
    /// by the RT callback, reset-on-read by the metering poll (FR: master meter).
    levels: Arc<[AtomicU32; 2]>,
    /// Source frames consumed per output frame (playback speed).
    rate: f64,
    start_frame: u64,
    loop_region: Option<LoopRegion>,
    output: Option<JoinHandle<()>>,
    render: Option<JoinHandle<()>>,
}

impl Playback {
    /// Current playhead position in project frames (tracks audible output).
    pub fn position(&self) -> u64 {
        let advanced = (self.played.load(Ordering::Relaxed) as f64 * self.rate) as u64;
        let raw = self.start_frame + advanced;
        match self.loop_region {
            Some(lr) if lr.end > lr.start && raw >= lr.start => {
                lr.start + (raw - lr.start) % (lr.end - lr.start)
            }
            _ => raw,
        }
    }

    /// Per-channel linear output peak since the previous call (reset-on-read).
    pub fn take_levels(&self) -> [f32; 2] {
        [
            f32::from_bits(self.levels[0].swap(0, Ordering::Relaxed)),
            f32::from_bits(self.levels[1].swap(0, Ordering::Relaxed)),
        ]
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
    speed: SpeedSpec,
) -> Result<Playback, EngineError> {
    let rate = speed.rate.clamp(0.25, 4.0);
    let sample_rate = project.sample_rate;
    let (_host, dev) = resolve_output_device(device_id)?;
    let (fmt, channels) = pick_output(&dev, sample_rate)?;

    let mixer = Arc::new(Mixer::new(project, channels)?);
    let total = mixer.total_frames();

    let stop = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let played = Arc::new(AtomicU64::new(0));
    let ended = Arc::new(AtomicBool::new(false));
    let levels: Arc<[AtomicU32; 2]> = Arc::new([AtomicU32::new(0), AtomicU32::new(0)]);

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
                let unity = (rate - 1.0).abs() < 1e-6;
                let mut src_pos = start_frame as f64;
                let mut block = vec![0.0f32; RENDER_BLOCK * oc];
                let mut src_block: Vec<f32> = Vec::new();
                let mut wsola =
                    (!unity && speed.preserve_pitch).then(|| Wsola::new(&mixer, oc, rate, src_pos));
                let mut stretch_out: Vec<f32> = Vec::new();
                loop {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    if paused.load(Ordering::SeqCst) {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    // Reached the end (no loop): let the ring drain, then stop.
                    let at_end = loop_region.is_none() && src_pos >= total as f64;
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
                    if unity {
                        mixer.mix_into(&mut block, src_pos as u64);
                        src_pos += RENDER_BLOCK as f64;
                    } else if let Some(w) = wsola.as_mut() {
                        // Pitch-preserving stretch: WSOLA hops until a block is ready.
                        let need = block.len();
                        while stretch_out.len() < need {
                            w.step(&mixer, &mut stretch_out);
                        }
                        block.copy_from_slice(&stretch_out[..need]);
                        stretch_out.drain(..need);
                        src_pos = w.next_nominal;
                    } else {
                        // Varispeed: resample the mixed stream (tape repitch).
                        let need = (RENDER_BLOCK as f64 * rate).ceil() as usize + 2;
                        src_block.resize(need * oc, 0.0);
                        let base = src_pos.floor();
                        mixer.mix_into(&mut src_block, base.max(0.0) as u64);
                        let mut fp = src_pos - base;
                        for i in 0..RENDER_BLOCK {
                            let i0 = fp as usize;
                            let t = (fp - i0 as f64) as f32;
                            for c in 0..oc {
                                let a = src_block[i0 * oc + c];
                                let b = src_block[(i0 + 1) * oc + c];
                                block[i * oc + c] = a + (b - a) * t;
                            }
                            fp += rate;
                        }
                        src_pos += RENDER_BLOCK as f64 * rate;
                    }
                    for &s in &block {
                        let _ = producer.push(s);
                    }
                    if let Some(lr) = loop_region {
                        if lr.end > lr.start && src_pos >= lr.end as f64 {
                            src_pos = lr.start as f64;
                            if let Some(w) = wsola.as_mut() {
                                *w = Wsola::new(&mixer, oc, rate, src_pos);
                                stretch_out.clear();
                            }
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
        let levels = levels.clone();
        thread::Builder::new()
            .name("waver-audio-output".into())
            .spawn(move || {
                let config = StreamConfig {
                    channels,
                    sample_rate,
                    buffer_size: BufferSize::Default,
                };
                let stream = match build_output_stream(
                    &dev, config, fmt, consumer, paused, played, levels, channels,
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
        levels,
        rate,
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
    levels: Arc<[AtomicU32; 2]>,
    channels: u16,
) -> Result<cpal::Stream, EngineError> {
    let oc = channels.max(1) as usize;
    macro_rules! build {
        ($t:ty) => {{
            let mut consumer = consumer;
            let paused = paused.clone();
            let played = played.clone();
            let levels = levels.clone();
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
                    // Local per-callback peaks (L, R); channels >2 fold into R.
                    let mut pk = [0.0f32; 2];
                    for (i, out) in data.iter_mut().enumerate() {
                        match consumer.pop() {
                            Ok(v) => {
                                *out = <$t>::from_sample(v);
                                let slot = usize::from(i % oc != 0);
                                let a = v.abs();
                                if a > pk[slot] {
                                    pk[slot] = a;
                                }
                                if i % oc == oc - 1 {
                                    frames += 1;
                                }
                            }
                            // Underrun: fill the rest with silence.
                            Err(_) => *out = <$t>::from_sample(0.0f32),
                        }
                    }
                    // Non-negative f32 bit patterns order like integers, so fetch_max
                    // on the bits is a lock-free float max (RT-safe, no CAS loop).
                    levels[0].fetch_max(pk[0].to_bits(), Ordering::Relaxed);
                    levels[1].fetch_max(pk[1].to_bits(), Ordering::Relaxed);
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
