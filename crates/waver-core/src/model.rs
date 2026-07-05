//! The non-destructive project model (spec §3).
//!
//! Source audio is immutable once imported/recorded; every edit is metadata on a
//! [`Clip`]. A cut/split never mutates the underlying [`Source`] — it produces two
//! clips referencing the same `source_id` with adjacent in/out points.
//!
//! Invariants (enforced by [`Project::validate`] and covered by unit tests):
//! - `source_in <= source_out <= Source.frames`
//! - `source_channel < Source.channels` when `Some`
//! - clips on a track may not overlap (v1 disallows overlap-crossfade)

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Errors returned by fallible model operations (splitting, trimming, …).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ModelError {
    #[error("split point {frame} is outside clip timeline range [{start}, {end})")]
    SplitOutOfRange { frame: u64, start: u64, end: u64 },
    #[error("trim would place source_in ({source_in}) after source_out ({source_out})")]
    InvalidTrim { source_in: u64, source_out: u64 },
    #[error("frame offset {offset} exceeds source length {frames}")]
    OutOfSourceBounds { offset: u64, frames: u64 },
}

/// Errors surfaced by [`Project::validate`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("clip {clip} references unknown source {source_id}")]
    UnknownSource { clip: Uuid, source_id: Uuid },
    #[error("clip {clip}: source_in ({source_in}) > source_out ({source_out})")]
    InvertedRange {
        clip: Uuid,
        source_in: u64,
        source_out: u64,
    },
    #[error("clip {clip}: source_out ({source_out}) exceeds source frames ({frames})")]
    OutOfBounds {
        clip: Uuid,
        source_out: u64,
        frames: u64,
    },
    #[error("clip {clip}: source_channel {channel} >= source channels ({channels})")]
    InvalidChannel {
        clip: Uuid,
        channel: u16,
        channels: u16,
    },
    #[error("track {track}: clips {a} and {b} overlap on the timeline")]
    OverlappingClips { track: Uuid, a: Uuid, b: Uuid },
}

/// Shape of a fade envelope. See spec FR-5.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum FadeCurve {
    #[default]
    Linear,
    /// Constant-power fade (sums to constant power at a crossfade point).
    EqualPower,
    /// Logarithmic / exponential curve.
    Log,
}

/// A fade-in or fade-out specification.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct FadeSpec {
    /// Length of the fade in frames. Clamped to clip length at apply time.
    pub len_frames: u64,
    pub curve: FadeCurve,
}

impl FadeSpec {
    /// A zero-length (no-op) fade.
    pub const NONE: FadeSpec = FadeSpec {
        len_frames: 0,
        curve: FadeCurve::Linear,
    };
}

/// A single decimation level of a waveform peak pyramid.
///
/// Peaks are min/max pairs per channel, one pair per bucket of `frames_per_bucket`
/// source frames. The full envelope math lives in peak generation (M3); this type
/// is the serialization-friendly container.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PeakLevel {
    pub frames_per_bucket: u32,
    pub channels: u16,
    /// Per-channel minima, laid out `[ch0_bucket0, ch1_bucket0, ch0_bucket1, …]`.
    pub mins: Vec<f32>,
    /// Per-channel maxima, same layout as `mins`.
    pub maxs: Vec<f32>,
}

/// Multi-resolution min/max peak cache for a [`Source`] (spec FR-3.1).
///
/// Populated by peak generation in M3. Not serialized into the project file — it is
/// a regenerable cache keyed off the immutable source file.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PeakPyramid {
    /// Decimation levels, coarsest first.
    pub levels: Vec<PeakLevel>,
}

/// An immutable imported or recorded audio file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    pub id: Uuid,
    pub path: std::path::PathBuf,
    pub channels: u16,
    pub sample_rate: u32,
    /// Length in frames (one frame = one sample per channel).
    pub frames: u64,
    /// Regenerable peak cache; excluded from the serialized project.
    #[serde(skip)]
    pub peaks: PeakPyramid,
}

impl Source {
    pub fn new(
        path: impl Into<std::path::PathBuf>,
        channels: u16,
        sample_rate: u32,
        frames: u64,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            path: path.into(),
            channels,
            sample_rate,
            frames,
            peaks: PeakPyramid::default(),
        }
    }
}

/// A placement of (a slice of) a [`Source`] on a track timeline.
///
/// The clip is non-destructive: `source_in`/`source_out` window into the immutable
/// source, and `timeline_start` places that window on the track.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Clip {
    pub id: Uuid,
    pub source_id: Uuid,
    /// `None` = all channels; `Some(n)` = a single split-out channel (spec FR-4.6).
    pub source_channel: Option<u16>,
    /// In-point within the source, in frames.
    pub source_in: u64,
    /// Out-point within the source, in frames.
    pub source_out: u64,
    /// Placement on the track timeline, in frames.
    pub timeline_start: u64,
    pub gain_db: f32,
    pub fade_in: FadeSpec,
    pub fade_out: FadeSpec,
}

impl Clip {
    /// Create a clip spanning the whole source at timeline position `timeline_start`.
    pub fn new(source: &Source, timeline_start: u64) -> Self {
        Self {
            id: Uuid::new_v4(),
            source_id: source.id,
            source_channel: None,
            source_in: 0,
            source_out: source.frames,
            timeline_start,
            gain_db: 0.0,
            fade_in: FadeSpec::NONE,
            fade_out: FadeSpec::NONE,
        }
    }

    /// Length of the clip in frames (source window length; v1 has no time-stretch,
    /// so timeline length equals source length).
    pub fn len(&self) -> u64 {
        self.source_out.saturating_sub(self.source_in)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The exclusive end of the clip on the timeline.
    pub fn timeline_end(&self) -> u64 {
        self.timeline_start + self.len()
    }

    /// Whether this clip's timeline range overlaps `other`'s.
    pub fn overlaps(&self, other: &Clip) -> bool {
        self.timeline_start < other.timeline_end() && other.timeline_start < self.timeline_end()
    }

    /// Split the clip at an absolute timeline frame, producing two contiguous clips
    /// that reference the same source (spec FR-4.3). `self` is left unmodified.
    ///
    /// The combined audio of the returned clips is sample-identical to the original:
    /// `left.source_out == right.source_in` and their union covers the same window.
    pub fn split_at_timeline(&self, frame: u64) -> Result<(Clip, Clip), ModelError> {
        let start = self.timeline_start;
        let end = self.timeline_end();
        if frame <= start || frame >= end {
            return Err(ModelError::SplitOutOfRange { frame, start, end });
        }
        let cut = frame - start; // offset within the source window
        let mid = self.source_in + cut;

        let mut left = self.clone();
        left.id = Uuid::new_v4();
        left.source_out = mid;
        left.fade_out = FadeSpec::NONE; // fade-out belongs to the right piece

        let mut right = self.clone();
        right.id = Uuid::new_v4();
        right.source_in = mid;
        right.timeline_start = frame;
        right.fade_in = FadeSpec::NONE; // fade-in belongs to the left piece

        Ok((left, right))
    }

    /// Set a new in-point (trim left edge), bounds-checked against `source_out`.
    ///
    /// This only adjusts the source window. Callers that want the remaining audio to
    /// stay anchored on the timeline must adjust `timeline_start` themselves.
    pub fn set_source_in(&mut self, source_in: u64) -> Result<(), ModelError> {
        if source_in > self.source_out {
            return Err(ModelError::InvalidTrim {
                source_in,
                source_out: self.source_out,
            });
        }
        self.source_in = source_in;
        Ok(())
    }

    /// Set a new out-point (trim right edge), bounds-checked against `source_in`.
    pub fn set_source_out(&mut self, source_out: u64) -> Result<(), ModelError> {
        if source_out < self.source_in {
            return Err(ModelError::InvalidTrim {
                source_in: self.source_in,
                source_out,
            });
        }
        self.source_out = source_out;
        Ok(())
    }
}

/// A track lane holding a sequence of non-overlapping clips.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: Uuid,
    pub name: String,
    pub gain_db: f32,
    pub muted: bool,
    pub soloed: bool,
    pub clips: Vec<Clip>,
}

impl Track {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            gain_db: 0.0,
            muted: false,
            soloed: false,
            clips: Vec::new(),
        }
    }
}

/// The top-level project: a master sample rate, a pool of immutable sources, and a
/// set of tracks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    /// Project master sample rate (e.g. 48000).
    pub sample_rate: u32,
    pub sources: Vec<Source>,
    pub tracks: Vec<Track>,
}

impl Project {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            sources: Vec::new(),
            tracks: Vec::new(),
        }
    }

    pub fn source(&self, id: Uuid) -> Option<&Source> {
        self.sources.iter().find(|s| s.id == id)
    }

    /// Enforce the §3 invariants across the whole project. Returns the first
    /// violation found, or `Ok(())` if the project is well-formed.
    pub fn validate(&self) -> Result<(), ValidationError> {
        for track in &self.tracks {
            for clip in &track.clips {
                let source = self
                    .source(clip.source_id)
                    .ok_or(ValidationError::UnknownSource {
                        clip: clip.id,
                        source_id: clip.source_id,
                    })?;

                if clip.source_in > clip.source_out {
                    return Err(ValidationError::InvertedRange {
                        clip: clip.id,
                        source_in: clip.source_in,
                        source_out: clip.source_out,
                    });
                }
                if clip.source_out > source.frames {
                    return Err(ValidationError::OutOfBounds {
                        clip: clip.id,
                        source_out: clip.source_out,
                        frames: source.frames,
                    });
                }
                if let Some(ch) = clip.source_channel {
                    if ch >= source.channels {
                        return Err(ValidationError::InvalidChannel {
                            clip: clip.id,
                            channel: ch,
                            channels: source.channels,
                        });
                    }
                }
            }

            // Overlap check: sort clip indices by timeline_start, compare neighbours.
            let mut ordered: Vec<&Clip> = track.clips.iter().collect();
            ordered.sort_by_key(|c| c.timeline_start);
            for pair in ordered.windows(2) {
                if pair[0].overlaps(pair[1]) {
                    return Err(ValidationError::OverlappingClips {
                        track: track.id,
                        a: pair[0].id,
                        b: pair[1].id,
                    });
                }
            }
        }
        Ok(())
    }

    /// Non-destructively place a freshly recorded [`Source`] on the timeline as a new
    /// clip (spec FR-2.5 overdub). The clip spans the whole source and starts at
    /// `timeline_start`. If `track_id` names an existing track the clip is appended
    /// there; otherwise a new track is created. Existing clips are untouched.
    /// Returns `(source_id, clip_id)`.
    pub fn add_recording(
        &mut self,
        source: Source,
        track_id: Option<Uuid>,
        timeline_start: u64,
    ) -> (Uuid, Uuid) {
        let clip = Clip::new(&source, timeline_start);
        let source_id = source.id;
        let clip_id = clip.id;
        self.sources.push(source);

        let track = match track_id.and_then(|id| self.tracks.iter_mut().find(|t| t.id == id)) {
            Some(track) => track,
            None => {
                let name = format!("Track {}", self.tracks.len() + 1);
                self.tracks.push(Track::new(name));
                self.tracks.last_mut().expect("just pushed")
            }
        };
        track.clips.push(clip);
        (source_id, clip_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Source, Project) {
        let src = Source::new("/tmp/take1.wav", 2, 48_000, 1_000);
        let mut project = Project::new(48_000);
        project.sources.push(src.clone());
        (src, project)
    }

    #[test]
    fn clip_spans_whole_source() {
        let (src, _) = fixture();
        let clip = Clip::new(&src, 0);
        assert_eq!(clip.source_in, 0);
        assert_eq!(clip.source_out, 1_000);
        assert_eq!(clip.len(), 1_000);
        assert_eq!(clip.timeline_end(), 1_000);
    }

    #[test]
    fn add_recording_places_overdub_nondestructively() {
        // Start with a project that already has a track + clip.
        let (existing_src, mut project) = fixture();
        let mut track = Track::new("A");
        let existing_clip = Clip::new(&existing_src, 0);
        let existing_clip_id = existing_clip.id;
        track.clips.push(existing_clip);
        let track_id = track.id;
        project.tracks.push(track);

        // Record a new source and place it at frame 2000 on a NEW track.
        let rec = Source::new("/tmp/take2.wav", 2, 48_000, 500);
        let rec_id = rec.id;
        let (source_id, clip_id) = project.add_recording(rec, None, 2_000);

        assert_eq!(source_id, rec_id);
        // The new source exists and the new clip references it at the right spot.
        assert!(project.source(source_id).is_some());
        let new_clip = project
            .tracks
            .iter()
            .flat_map(|t| &t.clips)
            .find(|c| c.id == clip_id)
            .expect("new clip present");
        assert_eq!(new_clip.source_id, source_id);
        assert_eq!(new_clip.timeline_start, 2_000);
        assert_eq!(new_clip.source_out, 500);

        // Existing clip untouched; a new track was created; project is valid.
        assert!(project
            .tracks
            .iter()
            .flat_map(|t| &t.clips)
            .any(|c| c.id == existing_clip_id));
        assert_eq!(project.tracks.len(), 2);
        assert_ne!(project.tracks[1].id, track_id);
        assert_eq!(project.validate(), Ok(()));
    }

    #[test]
    fn split_is_contiguous_and_lossless() {
        let (src, _) = fixture();
        let clip = Clip::new(&src, 100); // timeline 100..1100, source 0..1000
        let (left, right) = clip.split_at_timeline(600).unwrap();

        // Adjacent in/out points, same source.
        assert_eq!(left.source_out, right.source_in);
        assert_eq!(left.source_id, right.source_id);
        assert_eq!(left.source_id, clip.source_id);

        // Union covers exactly the original window (sample-identical on export).
        assert_eq!(left.source_in, clip.source_in);
        assert_eq!(right.source_out, clip.source_out);
        assert_eq!(left.len() + right.len(), clip.len());

        // Timeline placement stays contiguous.
        assert_eq!(left.timeline_end(), right.timeline_start);

        // Fresh, distinct ids; original untouched.
        assert_ne!(left.id, clip.id);
        assert_ne!(right.id, clip.id);
        assert_ne!(left.id, right.id);
        assert_eq!(clip.source_out, 1_000);
    }

    #[test]
    fn split_out_of_range_is_rejected() {
        let (src, _) = fixture();
        let clip = Clip::new(&src, 100);
        assert!(matches!(
            clip.split_at_timeline(100),
            Err(ModelError::SplitOutOfRange { .. })
        ));
        assert!(matches!(
            clip.split_at_timeline(1_100),
            Err(ModelError::SplitOutOfRange { .. })
        ));
    }

    #[test]
    fn overlap_detection() {
        let (src, _) = fixture();
        let a = Clip::new(&src, 0); // 0..1000
        let mut b = Clip::new(&src, 500); // 500..1500
        assert!(a.overlaps(&b));
        b.timeline_start = 1_000; // 1000..2000, edge-adjacent, no overlap
        assert!(!a.overlaps(&b));
    }

    #[test]
    fn validate_rejects_out_of_bounds_clip() {
        let (src, mut project) = fixture();
        let mut clip = Clip::new(&src, 0);
        clip.source_out = 2_000; // beyond source.frames = 1000
        let mut track = Track::new("A");
        track.clips.push(clip);
        project.tracks.push(track);
        assert!(matches!(
            project.validate(),
            Err(ValidationError::OutOfBounds { .. })
        ));
    }

    #[test]
    fn validate_rejects_overlap() {
        let (src, mut project) = fixture();
        let mut track = Track::new("A");
        track.clips.push(Clip::new(&src, 0)); // 0..1000
        track.clips.push(Clip::new(&src, 500)); // 500..1500
        project.tracks.push(track);
        assert!(matches!(
            project.validate(),
            Err(ValidationError::OverlappingClips { .. })
        ));
    }

    #[test]
    fn validate_accepts_wellformed_project() {
        let (src, mut project) = fixture();
        let mut track = Track::new("A");
        let a = Clip::new(&src, 0); // 0..1000
        let (left, mut right) = a.split_at_timeline(400).unwrap();
        right.timeline_start = 1_000; // move the right piece clear of the left
        track.clips.push(left);
        track.clips.push(right);
        project.tracks.push(track);
        assert_eq!(project.validate(), Ok(()));
    }

    #[test]
    fn project_round_trips_through_serde() {
        let (src, mut project) = fixture();
        let mut track = Track::new("A");
        track.clips.push(Clip::new(&src, 0));
        project.tracks.push(track);

        let json = serde_json::to_string(&project).unwrap();
        let restored: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(project, restored);
    }
}
