//! Import via Symphonia (spec FR-7.1).
//!
//! Decodes WAV / FLAC / MP3 / OGG-Vorbis / AAC / ALAC / AIFF to interleaved f32,
//! resamples to the project rate if they differ (so pitch/duration stay correct),
//! and transcodes to a 32-bit float WAV scratch file. Keeping every source as a WAV
//! at the project rate means peaks, mixing, and playback all operate uniformly.

use std::path::Path;

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::TrackType;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use waver_core::engine::EngineError;

use crate::capture::WavRecorder;
use crate::export::resample_interleaved;

/// Result of importing a file.
#[derive(Debug, Clone)]
pub struct ImportInfo {
    /// Path of the transcoded 32-bit float WAV scratch file.
    pub path: std::path::PathBuf,
    pub channels: u16,
    pub sample_rate: u32,
    pub frames: u64,
    /// True if the source was resampled to the project rate.
    pub resampled: bool,
}

/// Decode any Symphonia-supported file to interleaved f32 (symphonia 0.6 API).
pub(crate) fn decode(path: &Path) -> Result<(Vec<f32>, u16, u32), EngineError> {
    let be = |e: String| EngineError::Backend(format!("decode: {e}"));

    let file = std::fs::File::open(path)
        .map_err(|e| EngineError::Io(format!("open {}: {e}", path.display())))?;
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let mut reader = symphonia::default::get_probe()
        .probe(&hint, mss, Default::default(), Default::default())
        .map_err(|e| be(e.to_string()))?;

    let track = reader
        .default_track(TrackType::Audio)
        .ok_or_else(|| EngineError::Backend("no audio track".into()))?;
    let track_id = track.id;
    let audio_params = match track.codec_params.as_ref() {
        Some(CodecParameters::Audio(p)) => p.clone(),
        _ => {
            return Err(EngineError::Backend(
                "track has no audio codec params".into(),
            ))
        }
    };

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&audio_params, &AudioDecoderOptions::default())
        .map_err(|e| be(e.to_string()))?;

    let mut samples: Vec<f32> = Vec::new();
    let mut scratch: Vec<f32> = Vec::new();
    let mut channels: u16 = audio_params
        .channels
        .as_ref()
        .map(|c| c.count() as u16)
        .unwrap_or(0);
    let mut sample_rate: u32 = audio_params.sample_rate.unwrap_or(0);

    loop {
        let packet = match reader.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(be(e.to_string())),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = decoded.spec();
                sample_rate = spec.rate();
                channels = spec.channels().count() as u16;
                decoded.copy_to_vec_interleaved(&mut scratch);
                samples.extend_from_slice(&scratch);
            }
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(be(e.to_string())),
        }
    }

    if channels == 0 || sample_rate == 0 {
        return Err(EngineError::Backend("could not determine format".into()));
    }
    Ok((samples, channels, sample_rate))
}

/// Import `src_path`, transcoding to a float WAV at `out_path`, resampled to
/// `project_sample_rate` if the source differs.
pub fn import_file(
    src_path: impl AsRef<Path>,
    project_sample_rate: u32,
    out_path: impl AsRef<Path>,
) -> Result<ImportInfo, EngineError> {
    let (mut samples, channels, src_rate) = decode(src_path.as_ref())?;
    if samples.is_empty() {
        return Err(EngineError::Backend("decoded no audio".into()));
    }

    let resampled = src_rate != project_sample_rate;
    if resampled {
        samples = resample_interleaved(
            &samples,
            channels.max(1) as usize,
            src_rate,
            project_sample_rate,
        );
    }

    let mut rec = WavRecorder::create(out_path.as_ref(), channels, project_sample_rate)?;
    rec.write_interleaved(&samples)?;
    let info = rec.finalize()?;

    Ok(ImportInfo {
        path: info.path,
        channels: info.channels,
        sample_rate: info.sample_rate,
        frames: info.frames,
        resampled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::WavRecorder;

    #[test]
    fn imports_wav_and_resamples() {
        // Make a 44.1 kHz mono source, import into a 48 kHz project.
        let src = std::env::temp_dir().join("waver_import_src.wav");
        let mut rec = WavRecorder::create(&src, 1, 44_100).unwrap();
        let tone: Vec<f32> = (0..44_100)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 44_100.0).sin())
            .collect();
        rec.write_interleaved(&tone).unwrap();
        rec.finalize().unwrap();

        let out = std::env::temp_dir().join("waver_import_out.wav");
        let info = import_file(&src, 48_000, &out).unwrap();
        assert_eq!(info.sample_rate, 48_000);
        assert!(info.resampled);
        assert_eq!(info.channels, 1);
        // 1s at 44.1k resampled to 48k => ~48000 frames (pitch/duration preserved).
        assert!(
            (info.frames as i64 - 48_000).abs() <= 2,
            "frames {}",
            info.frames
        );
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&out);
    }
}
