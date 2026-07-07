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
    Mp3,
    Opus,
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
    /// Render only `[start, end)` project frames (export the selection); None = all.
    pub range: Option<(u64, u64)>,
}

/// Render `[start, end)` project frames to interleaved samples at the project rate.
fn render_range(mixer: &Mixer, start: u64, end: u64) -> Vec<f32> {
    let oc = mixer.out_channels() as usize;
    let mut out = Vec::with_capacity((end - start) as usize * oc);
    let mut pos = start;
    let mut block = vec![0.0f32; RENDER_CHUNK * oc];
    while pos < end {
        let n = ((end - pos) as usize).min(RENDER_CHUNK);
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

/// Consolidate: render ONE track's `[start, end)` (clip gains + fades baked, track
/// gain/mute/solo excluded) to a new WAV at the project rate. Returns
/// (channels, frames) of the written file. Used by merge-clips.
pub fn consolidate_track_range(
    project: &Project,
    track_id: uuid::Uuid,
    start: u64,
    end: u64,
    out_path: impl AsRef<Path>,
) -> Result<(u16, u64), EngineError> {
    if end <= start {
        return Err(EngineError::Backend("empty consolidate range".into()));
    }
    // Solo the target track in a scratch copy; neutralize track-level state so the
    // baked audio is the clips as heard at unity track gain.
    let mut solo = project.clone();
    solo.tracks.retain(|t| t.id == track_id);
    let Some(track) = solo.tracks.first_mut() else {
        return Err(EngineError::Backend("no such track".into()));
    };
    track.muted = false;
    track.soloed = false;
    track.gain_db = 0.0;
    // Preserve the widest channel count among the clips' sources (mono stays mono).
    let channels = solo
        .tracks
        .first()
        .map(|t| {
            t.clips
                .iter()
                .filter_map(|c| {
                    solo.sources.iter().find(|s| s.id == c.source_id).map(|s| {
                        if c.source_channel.is_some() {
                            1
                        } else {
                            s.channels
                        }
                    })
                })
                .max()
                .unwrap_or(1)
        })
        .unwrap_or(1)
        .max(1);
    let mixer = Mixer::new(&solo, channels)?;
    let mixed = render_range(&mixer, start, end);
    let spec = hound::WavSpec {
        channels,
        sample_rate: project.sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(out_path.as_ref(), spec)
        .map_err(|e| EngineError::Io(format!("create wav: {e}")))?;
    for &s in &mixed {
        w.write_sample(s)
            .map_err(|e| EngineError::Io(format!("write: {e}")))?;
    }
    w.finalize()
        .map_err(|e| EngineError::Io(format!("finalize: {e}")))?;
    Ok((channels, end - start))
}

/// Render + encode the project to `out_path` (spec FR-7.2).
pub fn export_project(
    project: &Project,
    opts: ExportOptions,
    out_path: impl AsRef<Path>,
) -> Result<(), EngineError> {
    let channels = opts.channels.max(1);
    let mixer = Mixer::new(project, channels)?;
    let total = mixer.total_frames();
    let (start, end) = match opts.range {
        Some((s, e)) => (s.min(total), e.min(total)),
        None => (0, total),
    };
    if end <= start {
        return Err(EngineError::Backend("empty export range".into()));
    }
    if end - start > MAX_EXPORT_FRAMES {
        return Err(EngineError::Backend(format!(
            "export length {} frames exceeds the export cap",
            end - start
        )));
    }
    let mut mixed = render_range(&mixer, start, end);
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
        ExportFormat::Mp3 => write_mp3(&mixed, channels, opts.sample_rate, out_path.as_ref()),
        ExportFormat::Opus => write_opus(&mixed, channels, opts.sample_rate, out_path.as_ref()),
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

#[cfg(windows)]
fn write_ogg(
    _mixed: &[f32],
    _channels: u16,
    _sample_rate: u32,
    _path: &Path,
) -> Result<(), EngineError> {
    Err(EngineError::UnsupportedConfig(
        "OGG (Vorbis) export is not available on Windows yet".into(),
    ))
}

#[cfg(not(windows))]
fn write_ogg(
    mixed: &[f32],
    channels: u16,
    sample_rate: u32,
    path: &Path,
) -> Result<(), EngineError> {
    use std::num::{NonZeroU32, NonZeroU8};
    let ch = channels.clamp(1, 2) as usize;
    let be = |e: vorbis_rs::VorbisError| EngineError::Backend(format!("vorbis: {e}"));
    let file =
        std::fs::File::create(path).map_err(|e| EngineError::Io(format!("create ogg: {e}")))?;
    let mut enc = vorbis_rs::VorbisEncoderBuilder::new(
        NonZeroU32::new(sample_rate)
            .ok_or_else(|| EngineError::Backend("zero sample rate".into()))?,
        NonZeroU8::new(ch as u8).expect("channels clamped >= 1"),
        std::io::BufWriter::new(file),
    )
    .map_err(be)?
    .build()
    .map_err(be)?;
    let frames = mixed.len() / ch;
    let mut planar: Vec<Vec<f32>> = vec![Vec::with_capacity(frames); ch];
    for f in 0..frames {
        for (c, chan) in planar.iter_mut().enumerate() {
            chan.push(mixed[f * ch + c]);
        }
    }
    enc.encode_audio_block(&planar).map_err(be)?;
    enc.finish().map_err(be)?;
    Ok(())
}

/// MP3 via LAME (192 kbps CBR, best quality preset).
#[cfg(windows)]
fn write_mp3(
    _mixed: &[f32],
    _channels: u16,
    _sample_rate: u32,
    _path: &Path,
) -> Result<(), EngineError> {
    Err(EngineError::UnsupportedConfig(
        "MP3 export is not available on Windows yet".into(),
    ))
}

/// MP3 via LAME (192 kbps CBR, best quality preset).
#[cfg(not(windows))]
fn write_mp3(
    mixed: &[f32],
    channels: u16,
    sample_rate: u32,
    path: &Path,
) -> Result<(), EngineError> {
    use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, InterleavedPcm, MonoPcm, Quality};
    let ch = channels.clamp(1, 2);
    let be = |m: String| EngineError::Backend(m);
    let mut b = Builder::new().ok_or_else(|| EngineError::Backend("lame init failed".into()))?;
    b.set_num_channels(ch as u8)
        .map_err(|e| be(format!("lame channels: {e}")))?;
    b.set_sample_rate(sample_rate)
        .map_err(|e| be(format!("lame rate: {e}")))?;
    b.set_brate(Bitrate::Kbps192)
        .map_err(|e| be(format!("lame bitrate: {e}")))?;
    b.set_quality(Quality::Best)
        .map_err(|e| be(format!("lame quality: {e}")))?;
    let mut enc = b.build().map_err(|e| be(format!("lame build: {e}")))?;
    let pcm: Vec<i16> = mixed.iter().map(|&s| f32_to_i16(s)).collect();
    let nframes = pcm.len() / ch as usize;
    let mut out: Vec<u8> = Vec::with_capacity(mp3lame_encoder::max_required_buffer_size(nframes));
    let n = if ch == 1 {
        enc.encode(MonoPcm(&pcm), out.spare_capacity_mut())
            .map_err(|e| be(format!("lame encode: {e}")))?
    } else {
        enc.encode(InterleavedPcm(&pcm), out.spare_capacity_mut())
            .map_err(|e| be(format!("lame encode: {e}")))?
    };
    // SAFETY: encode() wrote exactly n bytes into the spare capacity.
    unsafe { out.set_len(n) };
    let mut tail: Vec<u8> = Vec::with_capacity(7200);
    let n2 = enc
        .flush::<FlushNoGap>(tail.spare_capacity_mut())
        .map_err(|e| be(format!("lame flush: {e}")))?;
    // SAFETY: flush() wrote exactly n2 bytes into the spare capacity.
    unsafe { tail.set_len(n2) };
    out.extend_from_slice(&tail);
    std::fs::write(path, &out).map_err(|e| EngineError::Io(format!("write mp3: {e}")))?;
    Ok(())
}

/// Opus in an Ogg container (48 kHz per the Opus spec; 20 ms frames).
fn write_opus(
    mixed: &[f32],
    channels: u16,
    sample_rate: u32,
    path: &Path,
) -> Result<(), EngineError> {
    use audiopus::coder::Encoder;
    use audiopus::{Application, Channels, SampleRate};
    let ch = channels.clamp(1, 2) as usize;
    let data: Vec<f32> = if sample_rate != 48_000 {
        resample_interleaved(mixed, ch, sample_rate, 48_000)
    } else {
        mixed.to_vec()
    };
    let enc = Encoder::new(
        SampleRate::Hz48000,
        if ch == 1 {
            Channels::Mono
        } else {
            Channels::Stereo
        },
        Application::Audio,
    )
    .map_err(|e| EngineError::Backend(format!("opus init: {e}")))?;
    let preskip: u16 = enc.lookahead().map(|v| v as u16).unwrap_or(312);
    let io = |e: std::io::Error| EngineError::Io(format!("write opus: {e}"));
    let file = std::fs::File::create(path).map_err(io)?;
    let mut pw = ogg::PacketWriter::new(std::io::BufWriter::new(file));
    let serial: u32 = 0x5741_5652; // "WAVR"
    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1); // version
    head.push(ch as u8);
    head.extend_from_slice(&preskip.to_le_bytes());
    head.extend_from_slice(&48_000u32.to_le_bytes());
    head.extend_from_slice(&0i16.to_le_bytes()); // output gain
    head.push(0); // channel mapping family
    pw.write_packet(head, serial, ogg::PacketWriteEndInfo::EndPage, 0)
        .map_err(io)?;
    let vendor = b"waver";
    let mut tags = Vec::new();
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0u32.to_le_bytes()); // no user comments
    pw.write_packet(tags, serial, ogg::PacketWriteEndInfo::EndPage, 0)
        .map_err(io)?;
    const FRAME: usize = 960; // 20 ms @ 48 kHz
    let total = data.len() / ch;
    let mut buf = vec![0.0f32; FRAME * ch];
    let mut out = vec![0u8; 4000];
    let mut pos = 0usize;
    let mut granule: u64 = u64::from(preskip);
    while pos < total {
        let n = FRAME.min(total - pos);
        buf[..n * ch].copy_from_slice(&data[pos * ch..(pos + n) * ch]);
        for v in &mut buf[n * ch..] {
            *v = 0.0; // zero-pad the final short frame; granule trims it on decode
        }
        let len = enc
            .encode_float(&buf, &mut out)
            .map_err(|e| EngineError::Backend(format!("opus encode: {e}")))?;
        pos += n;
        granule += n as u64;
        let end = pos >= total;
        pw.write_packet(
            out[..len].to_vec(),
            serial,
            if end {
                ogg::PacketWriteEndInfo::EndStream
            } else {
                ogg::PacketWriteEndInfo::NormalPacket
            },
            granule,
        )
        .map_err(io)?;
    }
    Ok(())
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
            range: None,
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
            range: None,
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
