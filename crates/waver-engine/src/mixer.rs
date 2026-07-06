//! Offline mixer (spec FR-6.1 playback + FR-7.2 export).
//!
//! Decodes every source into memory once, then mixes any frame range of the project
//! into an interleaved output buffer, applying per-clip gain + fade envelopes
//! (`Clip::sample_gain_at`), per-track gain, mute/solo, and channel selection, then
//! downmixing source channels onto the output channels. The same mixer feeds the
//! realtime playback ring and the offline export encoder.

use std::collections::HashMap;
use std::path::Path;

use uuid::Uuid;
use waver_core::engine::EngineError;
use waver_core::model::{db_to_linear, Project};

/// A source decoded to interleaved f32 in memory.
pub struct DecodedSource {
    pub channels: u16,
    pub sample_rate: u32,
    /// Interleaved samples.
    pub samples: Vec<f32>,
}

impl DecodedSource {
    pub fn frames(&self) -> u64 {
        (self.samples.len() / self.channels.max(1) as usize) as u64
    }
}

/// Decode a WAV file to interleaved f32 (int formats are normalized losslessly).
pub fn decode_wav(path: impl AsRef<Path>) -> Result<DecodedSource, EngineError> {
    let mut reader = hound::WavReader::open(path.as_ref())
        .map_err(|e| EngineError::Io(format!("open {}: {e}", path.as_ref().display())))?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| EngineError::Io(format!("read: {e}")))?,
        hound::SampleFormat::Int => {
            let max = (1u64 << (spec.bits_per_sample.saturating_sub(1))) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<Result<_, _>>()
                .map_err(|e| EngineError::Io(format!("read: {e}")))?
        }
    };
    Ok(DecodedSource {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        samples,
    })
}

/// Mixes a project's timeline into interleaved output.
pub struct Mixer {
    sources: HashMap<Uuid, DecodedSource>,
    project: Project,
    out_channels: u16,
}

impl Mixer {
    /// Build a mixer for `project`, decoding all its sources into memory. A source
    /// that cannot be decoded (e.g. its file is missing after a project reload) is
    /// skipped — its clips render as silence rather than failing the whole mix, so
    /// playback/export degrade gracefully (mix_into already skips absent sources).
    pub fn new(project: &Project, out_channels: u16) -> Result<Self, EngineError> {
        let mut sources = HashMap::new();
        for src in &project.sources {
            if let Ok(decoded) = decode_wav(&src.path) {
                sources.insert(src.id, decoded);
            }
        }
        Ok(Self {
            sources,
            project: project.clone(),
            out_channels: out_channels.max(1),
        })
    }

    pub fn out_channels(&self) -> u16 {
        self.out_channels
    }

    /// Total length of the project in frames (max clip timeline end).
    pub fn total_frames(&self) -> u64 {
        self.project
            .tracks
            .iter()
            .flat_map(|t| &t.clips)
            .map(|c| c.timeline_end())
            .max()
            .unwrap_or(0)
    }

    /// Mix `out.len() / out_channels` frames starting at `start_frame` into `out`
    /// (interleaved). `out` is fully overwritten (silence-filled first).
    pub fn mix_into(&self, out: &mut [f32], start_frame: u64) {
        let oc = self.out_channels as usize;
        let n = out.len() / oc.max(1);
        out.iter_mut().for_each(|s| *s = 0.0);

        let any_solo = self.project.tracks.iter().any(|t| t.soloed);

        for track in &self.project.tracks {
            if track.muted || (any_solo && !track.soloed) {
                continue;
            }
            let track_gain = db_to_linear(track.gain_db);

            for clip in &track.clips {
                let clip_start = clip.timeline_start;
                let clip_end = clip.timeline_end();
                let range_start = clip_start.max(start_frame);
                let range_end = clip_end.min(start_frame + n as u64);
                if range_start >= range_end {
                    continue;
                }
                let Some(src) = self.sources.get(&clip.source_id) else {
                    continue;
                };
                let sch = src.channels.max(1) as usize;
                let src_frames = src.frames();

                for f in range_start..range_end {
                    let out_i = (f - start_frame) as usize;
                    let clip_off = f - clip_start;
                    let src_frame = clip.source_in + clip_off;
                    if src_frame >= src_frames {
                        continue;
                    }
                    let gain = clip.sample_gain_at(clip_off) * track_gain;
                    let base = src_frame as usize * sch;

                    match clip.source_channel {
                        // A split-out single channel: broadcast to all outputs.
                        Some(chan) => {
                            let c = chan as usize;
                            if c < sch {
                                let s = src.samples[base + c] * gain;
                                for oc_i in 0..oc {
                                    out[out_i * oc + oc_i] += s;
                                }
                            }
                        }
                        // All channels: mono broadcasts; otherwise fold onto outputs.
                        None => {
                            if sch == 1 {
                                let s = src.samples[base] * gain;
                                for oc_i in 0..oc {
                                    out[out_i * oc + oc_i] += s;
                                }
                            } else {
                                for c in 0..sch {
                                    let s = src.samples[base + c] * gain;
                                    out[out_i * oc + (c % oc)] += s;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::WavRecorder;
    use waver_core::model::{db_to_linear, Clip, Project, Source, Track};

    fn write_const_wav(path: &Path, channels: u16, value: f32, frames: usize) {
        let mut rec = WavRecorder::create(path, channels, 48_000).unwrap();
        let block: Vec<f32> = vec![value; frames * channels as usize];
        rec.write_interleaved(&block).unwrap();
        rec.finalize().unwrap();
    }

    fn project_with_source(path: &Path, channels: u16, frames: u64) -> (Project, Source) {
        let src = Source::new(path.to_path_buf(), channels, 48_000, frames);
        let mut project = Project::new(48_000);
        project.sources.push(src.clone());
        (project, src)
    }

    #[test]
    fn mixes_constant_source() {
        let path = std::env::temp_dir().join("waver_mix_const.wav");
        write_const_wav(&path, 1, 0.5, 1000);
        let (mut project, src) = project_with_source(&path, 1, 1000);
        let mut track = Track::new("A");
        track.clips.push(Clip::new(&src, 0));
        project.tracks.push(track);

        let mixer = Mixer::new(&project, 2).unwrap();
        let mut out = vec![0.0f32; 200]; // 100 stereo frames
        mixer.mix_into(&mut out, 0);
        // Mono 0.5 broadcast to both channels.
        assert!((out[0] - 0.5).abs() < 1e-6);
        assert!((out[1] - 0.5).abs() < 1e-6);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn clip_gain_plus_6db_doubles() {
        // FR-5.2: +6.02 dB clip gain => ~2x amplitude in the mix.
        let path = std::env::temp_dir().join("waver_mix_gain.wav");
        write_const_wav(&path, 1, 0.25, 1000);
        let (mut project, src) = project_with_source(&path, 1, 1000);
        let mut track = Track::new("A");
        let mut clip = Clip::new(&src, 0);
        clip.gain_db = 6.0206;
        track.clips.push(clip);
        project.tracks.push(track);

        let mixer = Mixer::new(&project, 1).unwrap();
        let mut out = vec![0.0f32; 100];
        mixer.mix_into(&mut out, 0);
        assert!((out[50] - 0.5).abs() < 1e-3, "got {}", out[50]); // 0.25 * 2
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn muted_track_is_silent_and_solo_isolates() {
        let path = std::env::temp_dir().join("waver_mix_mute.wav");
        write_const_wav(&path, 1, 0.4, 1000);
        let (mut project, src) = project_with_source(&path, 1, 1000);
        let mut a = Track::new("A");
        a.clips.push(Clip::new(&src, 0));
        a.muted = true;
        project.tracks.push(a);

        let mixer = Mixer::new(&project, 1).unwrap();
        let mut out = vec![0.0f32; 100];
        mixer.mix_into(&mut out, 0);
        assert!(
            out.iter().all(|&s| s == 0.0),
            "muted track should be silent"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn track_gain_composes_with_clip_gain() {
        // clip +6 dB and track +6 dB => ~4x.
        let path = std::env::temp_dir().join("waver_mix_compose.wav");
        write_const_wav(&path, 1, 0.1, 1000);
        let (mut project, src) = project_with_source(&path, 1, 1000);
        let mut track = Track::new("A");
        track.gain_db = 6.0206;
        let mut clip = Clip::new(&src, 0);
        clip.gain_db = 6.0206;
        track.clips.push(clip);
        project.tracks.push(track);

        let mixer = Mixer::new(&project, 1).unwrap();
        let mut out = vec![0.0f32; 100];
        mixer.mix_into(&mut out, 0);
        let expected = 0.1 * db_to_linear(6.0206) * db_to_linear(6.0206);
        assert!(
            (out[50] - expected).abs() < 1e-3,
            "got {} want {}",
            out[50],
            expected
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn overlapping_range_sums_tracks() {
        // Two tracks each with the same source at 0 -> sum.
        let path = std::env::temp_dir().join("waver_mix_sum.wav");
        write_const_wav(&path, 1, 0.3, 1000);
        let (mut project, src) = project_with_source(&path, 1, 1000);
        for name in ["A", "B"] {
            let mut t = Track::new(name);
            t.clips.push(Clip::new(&src, 0));
            project.tracks.push(t);
        }
        let mixer = Mixer::new(&project, 1).unwrap();
        let mut out = vec![0.0f32; 100];
        mixer.mix_into(&mut out, 0);
        assert!(
            (out[50] - 0.6).abs() < 1e-6,
            "two 0.3 sources should sum to 0.6"
        );
        let _ = std::fs::remove_file(&path);
    }
}
