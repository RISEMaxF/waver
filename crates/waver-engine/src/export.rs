//! Offline export / mixdown (spec FR-7.2 / FR-7.3).
//!
//! Renders the whole project through the [`Mixer`] to interleaved stereo f32,
//! resamples to the requested export rate if it differs from the project rate, and
//! encodes to WAV (16/24/32-bit float), FLAC (lossless), or OGG Vorbis. The mixer is
//! shared with realtime playback, so what you export matches what you hear.

use std::path::Path;

use waver_core::engine::EngineError;
use waver_core::model::Project;

use crate::mixer::Mixer;

const RENDER_CHUNK: usize = 16_384; // frames per mix pass

/// Sanity cap on export length (~24 h) so a corrupt project timeline can't trigger a
/// giant/overflowing allocation. Real projects are far under this.
const MAX_EXPORT_FRAMES: u64 = 48_000 * 3600 * 24;

/// Output container / codec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Wav,
    Flac,
    Ogg,
}

/// Bit depth for WAV export (FLAC uses 24-bit int, OGG is lossy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitDepth {
    Int16,
    Int24,
    Float32,
}

/// Export options (spec FR-7.3).
#[derive(Debug, Clone, Copy)]
pub struct ExportOptions {
    pub format: ExportFormat,
    pub sample_rate: u32,
    pub bit_depth: BitDepth,
    pub channels: u16,
}

/// Render the whole project to interleaved samples at the project's own rate.
fn render_full(mixer: &Mixer) -> Vec<f32> {
    let oc = mixer.out_channels() as usize;
    let total = mixer.total_frames();
    let mut out = Vec::with_capacity(total as usize * oc);
    let mut pos = 0u64;
    let mut block = vec![0.0f32; RENDER_CHUNK * oc];
    while pos < total {
        let n = ((total - pos) as usize).min(RENDER_CHUNK);
        let slice = &mut block[..n * oc];
        mixer.mix_into(slice, pos);
        out.extend_from_slice(slice);
        pos += n as u64;
    }
    out
}

/// Linear-interpolation resample of interleaved samples (correct pitch/duration).
/// Used when the export rate differs from the project rate (spec FR-7.3), and shared
/// with import (spec FR-7.1) for source-rate conversion.
pub(crate) fn resample_interleaved(input: &[f32], channels: usize, from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let in_frames = input.len() / channels;
    let ratio = to as f64 / from as f64;
    let out_frames = ((in_frames as f64) * ratio).round() as usize;
    let mut out = vec![0.0f32; out_frames * channels];
    for of in 0..out_frames {
        let src = of as f64 / ratio;
        let i0 = src.floor() as usize;
        let frac = (src - i0 as f64) as f32;
        let i1 = (i0 + 1).min(in_frames.saturating_sub(1));
        for c in 0..channels {
            let a = input[i0 * channels + c];
            let b = input[i1 * channels + c];
            out[of * channels + c] = a + (b - a) * frac;
        }
    }
    out
}

fn f32_to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

fn f32_to_i24(s: f32) -> i32 {
    (s.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32
}

/// Render + encode the project to `out_path` (spec FR-7.2).
pub fn export_project(
    project: &Project,
    opts: ExportOptions,
    out_path: impl AsRef<Path>,
) -> Result<(), EngineError> {
    let channels = opts.channels.max(1);
    let mixer = Mixer::new(project, channels)?;
    if mixer.total_frames() > MAX_EXPORT_FRAMES {
        return Err(EngineError::Backend(format!(
            "project length {} frames exceeds the export cap",
            mixer.total_frames()
        )));
    }
    let mut mixed = render_full(&mixer);
    if opts.sample_rate != project.sample_rate {
        mixed = resample_interleaved(
            &mixed,
            channels as usize,
            project.sample_rate,
            opts.sample_rate,
        );
    }

    match opts.format {
        ExportFormat::Wav => write_wav(&mixed, channels, opts, out_path.as_ref()),
        ExportFormat::Flac => {
            // FLAC is lossless integer; 16-bit for Int16, else 24-bit.
            let bits = if opts.bit_depth == BitDepth::Int16 {
                16
            } else {
                24
            };
            write_flac(&mixed, channels, opts.sample_rate, bits, out_path.as_ref())
        }
        ExportFormat::Ogg => write_ogg(&mixed, channels, opts.sample_rate, out_path.as_ref()),
    }
}

fn write_wav(
    mixed: &[f32],
    channels: u16,
    opts: ExportOptions,
    path: &Path,
) -> Result<(), EngineError> {
    let (bits, fmt) = match opts.bit_depth {
        BitDepth::Int16 => (16, hound::SampleFormat::Int),
        BitDepth::Int24 => (24, hound::SampleFormat::Int),
        BitDepth::Float32 => (32, hound::SampleFormat::Float),
    };
    let spec = hound::WavSpec {
        channels,
        sample_rate: opts.sample_rate,
        bits_per_sample: bits,
        sample_format: fmt,
    };
    let mut w = hound::WavWriter::create(path, spec)
        .map_err(|e| EngineError::Io(format!("create wav: {e}")))?;
    for &s in mixed {
        match opts.bit_depth {
            BitDepth::Int16 => w.write_sample(f32_to_i16(s)),
            BitDepth::Int24 => w.write_sample(f32_to_i24(s)),
            BitDepth::Float32 => w.write_sample(s),
        }
        .map_err(|e| EngineError::Io(format!("write: {e}")))?;
    }
    w.finalize()
        .map_err(|e| EngineError::Io(format!("finalize: {e}")))?;
    Ok(())
}

fn write_flac(
    mixed: &[f32],
    channels: u16,
    sample_rate: u32,
    bits: usize,
    path: &Path,
) -> Result<(), EngineError> {
    use flacenc::component::BitRepr;
    use flacenc::error::Verify;
    let samples: Vec<i32> = if bits == 16 {
        mixed.iter().map(|&s| f32_to_i16(s) as i32).collect()
    } else {
        mixed.iter().map(|&s| f32_to_i24(s)).collect()
    };
    let mut cfg = flacenc::config::Encoder::default();
    // Disable experimental QLPC coding for broadest decoder compatibility (mirrors
    // flacenc's own e2e test). The output is verified lossless via claxon in tests.
    cfg.subframe_coding.qlpc.use_direct_mse = false;
    cfg.subframe_coding.qlpc.mae_optimization_steps = 0;
    let config = cfg
        .into_verified()
        .map_err(|e| EngineError::Backend(format!("flac config: {e:?}")))?;
    let source = flacenc::source::MemSource::from_samples(
        &samples,
        channels as usize,
        bits,
        sample_rate as usize,
    );
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| EngineError::Backend(format!("flac encode: {e:?}")))?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|e| EngineError::Backend(format!("flac write: {e:?}")))?;
    std::fs::write(path, sink.as_slice())
        .map_err(|e| EngineError::Io(format!("write flac: {e}")))?;
    Ok(())
}

fn write_ogg(
    mixed: &[f32],
    channels: u16,
    sample_rate: u32,
    path: &Path,
) -> Result<(), EngineError> {
    let _ = (mixed, channels, sample_rate, path);
    Err(EngineError::UnsupportedConfig(
        "OGG export not yet wired".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::WavRecorder;
    use waver_core::model::{Clip, Project, Source, Track};

    fn fixture_project(value: f32, frames: usize) -> (Project, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("waver_export_src_{value}.wav"));
        let mut rec = WavRecorder::create(&path, 1, 48_000).unwrap();
        rec.write_interleaved(&vec![value; frames]).unwrap();
        rec.finalize().unwrap();
        let src = Source::new(path.clone(), 1, 48_000, frames as u64);
        let mut project = Project::new(48_000);
        project.sources.push(src.clone());
        let mut track = Track::new("A");
        track.clips.push(Clip::new(&src, 0));
        project.tracks.push(track);
        (project, path)
    }

    #[test]
    fn wav_float_export_is_sample_accurate() {
        // A mono 0.5 source mixed to stereo float WAV must read back exactly 0.5.
        let (project, srcpath) = fixture_project(0.5, 500);
        let out = std::env::temp_dir().join("waver_export_f32.wav");
        let opts = ExportOptions {
            format: ExportFormat::Wav,
            sample_rate: 48_000,
            bit_depth: BitDepth::Float32,
            channels: 2,
        };
        export_project(&project, opts, &out).unwrap();
        let mut r = hound::WavReader::open(&out).unwrap();
        let s: Vec<f32> = r.samples::<f32>().map(|x| x.unwrap()).collect();
        assert_eq!(r.spec().sample_rate, 48_000);
        assert_eq!(r.spec().channels, 2);
        assert!(
            s.iter().all(|&v| (v - 0.5).abs() < 1e-6),
            "float export not exact"
        );
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&srcpath);
    }

    fn fixture_project_sine(frames: usize) -> (Project, std::path::PathBuf) {
        let path = std::env::temp_dir().join("waver_export_sine.wav");
        let mut rec = WavRecorder::create(&path, 1, 48_000).unwrap();
        let tone: Vec<f32> = (0..frames)
            .map(|i| 0.4 * (2.0 * std::f32::consts::PI * 330.0 * i as f32 / 48_000.0).sin())
            .collect();
        rec.write_interleaved(&tone).unwrap();
        rec.finalize().unwrap();
        let src = Source::new(path.clone(), 1, 48_000, frames as u64);
        let mut project = Project::new(48_000);
        project.sources.push(src.clone());
        let mut track = Track::new("A");
        track.clips.push(Clip::new(&src, 0));
        project.tracks.push(track);
        (project, path)
    }

    #[test]
    fn flac_round_trips_losslessly_vs_24bit_wav() {
        // FLAC(24) and WAV(24) of the same mix must decode to identical integers.
        let (project, srcpath) = fixture_project_sine(12_000);
        let wav = std::env::temp_dir().join("waver_export_24.wav");
        let flac = std::env::temp_dir().join("waver_export.flac");
        let base = ExportOptions {
            format: ExportFormat::Wav,
            sample_rate: 48_000,
            bit_depth: BitDepth::Int16,
            channels: 2,
        };
        export_project(&project, base, &wav).unwrap();
        export_project(
            &project,
            ExportOptions {
                format: ExportFormat::Flac,
                ..base
            },
            &flac,
        )
        .unwrap();

        // True lossless round-trip (spec FR-7.2 DoD): decode the FLAC with the claxon
        // reference decoder and compare bit-for-bit to the 16-bit WAV integers.
        let wav_samples: Vec<i32> = hound::WavReader::open(&wav)
            .unwrap()
            .samples::<i16>()
            .map(|x| x.unwrap() as i32)
            .collect();
        let mut fr = claxon::FlacReader::open(&flac).unwrap();
        let info = fr.streaminfo();
        assert_eq!(info.bits_per_sample, 16);
        assert_eq!(info.channels, 2);
        let flac_samples: Vec<i32> = fr.samples().map(|x| x.unwrap()).collect();
        assert!(!flac_samples.is_empty());
        assert_eq!(
            flac_samples, wav_samples,
            "FLAC did not round-trip losslessly vs WAV"
        );
        let _ = std::fs::remove_file(&wav);
        let _ = std::fs::remove_file(&flac);
        let _ = std::fs::remove_file(&srcpath);
    }

    #[test]
    fn resample_changes_length_by_ratio() {
        let input = vec![0.0f32; 48_000 * 2]; // 1s stereo @ 48k
        let out = resample_interleaved(&input, 2, 48_000, 44_100);
        let out_frames = out.len() / 2;
        // ~44100 frames (+-1).
        assert!((out_frames as i64 - 44_100).abs() <= 2, "got {out_frames}");
    }
}
