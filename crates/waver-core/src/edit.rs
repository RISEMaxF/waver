//! Timeline editing operations (spec FR-4.x, FR-5.2) and undo/redo history (FR-4.7).
//!
//! All operations are non-destructive: they only rearrange [`Clip`] metadata and
//! never touch the underlying immutable [`Source`]. Undo/redo uses whole-project
//! snapshots, which makes reversal exact (deep-equality) — the FR-4.7 acceptance
//! criterion — at the cost of cloning the (small) project model per edit.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::{Clip, Project, Track};

/// Errors from editing operations.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EditError {
    #[error("no clip with id {0}")]
    ClipNotFound(Uuid),
    #[error("no track with id {0}")]
    TrackNotFound(Uuid),
    #[error("no source with id {0}")]
    SourceNotFound(Uuid),
    #[error("clip has only one channel; nothing to split")]
    NotMultichannel,
    #[error("invalid edit: {0}")]
    Invalid(String),
}

impl Project {
    /// Locate a clip by id, returning `(track_index, clip_index)`.
    fn locate_clip(&self, clip_id: Uuid) -> Option<(usize, usize)> {
        for (ti, track) in self.tracks.iter().enumerate() {
            if let Some(ci) = track.clips.iter().position(|c| c.id == clip_id) {
                return Some((ti, ci));
            }
        }
        None
    }

    /// Find a clip by id (immutable).
    pub fn clip(&self, clip_id: Uuid) -> Option<&Clip> {
        self.locate_clip(clip_id)
            .map(|(ti, ci)| &self.tracks[ti].clips[ci])
    }

    /// Add an empty track, returning its id.
    pub fn add_track(&mut self, name: impl Into<String>) -> Uuid {
        let track = Track::new(name);
        let id = track.id;
        self.tracks.push(track);
        id
    }

    /// Split a clip at an absolute timeline frame into two contiguous clips
    /// referencing the same source (spec FR-4.3). Returns `(left_id, right_id)`.
    pub fn split_clip(&mut self, clip_id: Uuid, frame: u64) -> Result<(Uuid, Uuid), EditError> {
        let (ti, ci) = self
            .locate_clip(clip_id)
            .ok_or(EditError::ClipNotFound(clip_id))?;
        let (left, right) = self.tracks[ti].clips[ci]
            .split_at_timeline(frame)
            .map_err(|e| EditError::Invalid(e.to_string()))?;
        let ids = (left.id, right.id);
        // Replace the original clip with the two halves.
        self.tracks[ti].clips.splice(ci..=ci, [left, right]);
        Ok(ids)
    }

    /// Trim the right edge to end at `new_timeline_end` (spec FR-4.4). Adjusts
    /// `source_out` only; does not move other clips. Clamped to source bounds.
    pub fn trim_clip_end(&mut self, clip_id: Uuid, new_timeline_end: u64) -> Result<(), EditError> {
        let (ti, ci) = self
            .locate_clip(clip_id)
            .ok_or(EditError::ClipNotFound(clip_id))?;
        let clip = &self.tracks[ti].clips[ci];
        let source = self
            .source(clip.source_id)
            .ok_or(EditError::SourceNotFound(clip.source_id))?;
        let start = clip.timeline_start;
        // New length is bounded to at least 1 frame and at most the remaining source.
        let max_len = source.frames - clip.source_in;
        let new_len = new_timeline_end
            .saturating_sub(start)
            .clamp(1, max_len.max(1));
        let clip = &mut self.tracks[ti].clips[ci];
        clip.source_out = clip.source_in + new_len;
        Ok(())
    }

    /// Trim the left edge to start at `new_timeline_start` (spec FR-4.4). Moves the
    /// clip's start and `source_in` together so the audio stays anchored in time;
    /// does not move other clips. Clamped so the clip keeps >= 1 frame.
    pub fn trim_clip_start(
        &mut self,
        clip_id: Uuid,
        new_timeline_start: u64,
    ) -> Result<(), EditError> {
        let (ti, ci) = self
            .locate_clip(clip_id)
            .ok_or(EditError::ClipNotFound(clip_id))?;
        let clip = &mut self.tracks[ti].clips[ci];
        let old_start = clip.timeline_start;
        let old_in = clip.source_in;
        // How far the left edge moves (positive = later, trimming off the head).
        let delta = new_timeline_start as i64 - old_start as i64;
        // New source_in, clamped to [0, source_out-1].
        let new_in = (old_in as i64 + delta).clamp(0, clip.source_out as i64 - 1) as u64;
        // Recompute the actual applied delta after clamping so start stays consistent.
        let applied = new_in as i64 - old_in as i64;
        clip.source_in = new_in;
        clip.timeline_start = (old_start as i64 + applied).max(0) as u64;
        Ok(())
    }

    /// Move a clip to a new track and timeline position (spec FR-4.2).
    pub fn move_clip(
        &mut self,
        clip_id: Uuid,
        new_track_id: Uuid,
        new_timeline_start: u64,
    ) -> Result<(), EditError> {
        let (ti, ci) = self
            .locate_clip(clip_id)
            .ok_or(EditError::ClipNotFound(clip_id))?;
        let target = self
            .tracks
            .iter()
            .position(|t| t.id == new_track_id)
            .ok_or(EditError::TrackNotFound(new_track_id))?;
        let mut clip = self.tracks[ti].clips.remove(ci);
        clip.timeline_start = new_timeline_start;
        self.tracks[target].clips.push(clip);
        // Keep clips ordered by start for tidy rendering / neighbour ops.
        self.tracks[target].clips.sort_by_key(|c| c.timeline_start);
        Ok(())
    }

    /// Delete a clip (spec FR-4.5).
    pub fn delete_clip(&mut self, clip_id: Uuid) -> Result<(), EditError> {
        let (ti, ci) = self
            .locate_clip(clip_id)
            .ok_or(EditError::ClipNotFound(clip_id))?;
        self.tracks[ti].clips.remove(ci);
        Ok(())
    }

    /// Ripple-delete: remove a clip and shift later clips on the same track left by
    /// the deleted clip's length, preserving their relative spacing (spec FR-4.5).
    pub fn ripple_delete_clip(&mut self, clip_id: Uuid) -> Result<(), EditError> {
        let (ti, ci) = self
            .locate_clip(clip_id)
            .ok_or(EditError::ClipNotFound(clip_id))?;
        let removed = self.tracks[ti].clips.remove(ci);
        let gap = removed.len();
        let cutoff = removed.timeline_start;
        for clip in &mut self.tracks[ti].clips {
            if clip.timeline_start >= cutoff {
                clip.timeline_start = clip.timeline_start.saturating_sub(gap);
            }
        }
        Ok(())
    }

    /// Explode a multichannel clip into one mono clip per channel, each on its own
    /// track (spec FR-4.6). The source is untouched; each new clip carries a
    /// `source_channel`. Returns the new clip ids (channel order).
    pub fn split_clip_channels(&mut self, clip_id: Uuid) -> Result<Vec<Uuid>, EditError> {
        let (ti, ci) = self
            .locate_clip(clip_id)
            .ok_or(EditError::ClipNotFound(clip_id))?;
        let clip = self.tracks[ti].clips[ci].clone();
        let source = self
            .source(clip.source_id)
            .ok_or(EditError::SourceNotFound(clip.source_id))?;
        let channels = source.channels;
        if channels <= 1 {
            return Err(EditError::NotMultichannel);
        }

        // Channel 0 replaces the original clip on its track; the rest go on new tracks.
        let mut new_ids = Vec::with_capacity(channels as usize);
        let base_name = self.tracks[ti].name.clone();

        let mut ch0 = clip.clone();
        ch0.id = Uuid::new_v4();
        ch0.source_channel = Some(0);
        new_ids.push(ch0.id);
        self.tracks[ti].clips[ci] = ch0;

        for c in 1..channels {
            let mut mono = clip.clone();
            mono.id = Uuid::new_v4();
            mono.source_channel = Some(c);
            new_ids.push(mono.id);
            let track_id = self.add_track(format!("{base_name} · ch{}", c + 1));
            let idx = self.tracks.iter().position(|t| t.id == track_id).unwrap();
            self.tracks[idx].clips.push(mono);
        }
        Ok(new_ids)
    }

    /// Set a clip's gain in dB (spec FR-5.2).
    pub fn set_clip_gain(&mut self, clip_id: Uuid, gain_db: f32) -> Result<(), EditError> {
        let (ti, ci) = self
            .locate_clip(clip_id)
            .ok_or(EditError::ClipNotFound(clip_id))?;
        self.tracks[ti].clips[ci].gain_db = gain_db;
        Ok(())
    }

    /// Set a track's gain in dB (spec FR-5.2).
    pub fn set_track_gain(&mut self, track_id: Uuid, gain_db: f32) -> Result<(), EditError> {
        let track = self
            .tracks
            .iter_mut()
            .find(|t| t.id == track_id)
            .ok_or(EditError::TrackNotFound(track_id))?;
        track.gain_db = gain_db;
        Ok(())
    }
}

/// Snapshot-based undo/redo history (spec FR-4.7).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct History {
    past: Vec<Project>,
    future: Vec<Project>,
    limit: usize,
}

impl Default for History {
    fn default() -> Self {
        Self::new(100)
    }
}

impl History {
    pub fn new(limit: usize) -> Self {
        Self {
            past: Vec::new(),
            future: Vec::new(),
            limit: limit.max(1),
        }
    }

    /// Record `current` as an undo point. Call *before* applying an edit. Clears the
    /// redo stack (a new edit invalidates any redo future).
    pub fn snapshot(&mut self, current: &Project) {
        self.past.push(current.clone());
        if self.past.len() > self.limit {
            self.past.remove(0);
        }
        self.future.clear();
    }

    pub fn can_undo(&self) -> bool {
        !self.past.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.future.is_empty()
    }

    /// Undo: restore the previous snapshot into `current`. Returns false if empty.
    pub fn undo(&mut self, current: &mut Project) -> bool {
        match self.past.pop() {
            Some(prev) => {
                self.future.push(std::mem::replace(current, prev));
                true
            }
            None => false,
        }
    }

    /// Redo: reapply the next snapshot into `current`. Returns false if empty.
    pub fn redo(&mut self, current: &mut Project) -> bool {
        match self.future.pop() {
            Some(next) => {
                self.past.push(std::mem::replace(current, next));
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Source;

    fn project_with_clip() -> (Project, Uuid, Uuid) {
        let src = Source::new("/tmp/a.wav", 2, 48_000, 10_000);
        let mut project = Project::new(48_000);
        project.sources.push(src.clone());
        let track = crate::model::Track::new("A");
        let track_id = track.id;
        project.tracks.push(track);
        let clip = Clip::new(&src, 0);
        let clip_id = clip.id;
        project.tracks[0].clips.push(clip);
        (project, track_id, clip_id)
    }

    #[test]
    fn split_produces_contiguous_clips() {
        let (mut p, _t, clip_id) = project_with_clip();
        let (l, r) = p.split_clip(clip_id, 4_000).unwrap();
        let left = p.clip(l).unwrap();
        let right = p.clip(r).unwrap();
        assert_eq!(left.source_out, right.source_in); // sample-contiguous (FR-4.3)
        assert_eq!(left.len() + right.len(), 10_000);
        assert_eq!(p.validate(), Ok(()));
    }

    #[test]
    fn trim_end_bounds_to_source() {
        let (mut p, _t, clip_id) = project_with_clip();
        p.trim_clip_end(clip_id, 3_000).unwrap();
        assert_eq!(p.clip(clip_id).unwrap().source_out, 3_000);
        // Over-long trim clamps to the source length.
        p.trim_clip_end(clip_id, 999_999).unwrap();
        assert_eq!(p.clip(clip_id).unwrap().source_out, 10_000);
    }

    #[test]
    fn trim_start_anchors_audio() {
        let (mut p, _t, clip_id) = project_with_clip();
        p.trim_clip_start(clip_id, 2_000).unwrap();
        let c = p.clip(clip_id).unwrap();
        assert_eq!(c.source_in, 2_000);
        assert_eq!(c.timeline_start, 2_000);
    }

    #[test]
    fn ripple_delete_closes_gap() {
        let (mut p, _t, first) = project_with_clip();
        // Add a second clip after the first.
        let src = p.sources[0].clone();
        let mut c2 = Clip::new(&src, 10_000);
        c2.source_out = 5_000; // length 5000
        let c2_id = c2.id;
        p.tracks[0].clips.push(c2);

        // Ripple-delete the first (length 10000) -> c2 shifts left by 10000.
        p.ripple_delete_clip(first).unwrap();
        assert_eq!(p.clip(c2_id).unwrap().timeline_start, 0);
        assert_eq!(p.validate(), Ok(()));
    }

    #[test]
    fn channel_split_makes_one_clip_per_channel() {
        let (mut p, _t, clip_id) = project_with_clip(); // stereo source
        let ids = p.split_clip_channels(clip_id).unwrap();
        assert_eq!(ids.len(), 2);
        assert_eq!(p.clip(ids[0]).unwrap().source_channel, Some(0));
        assert_eq!(p.clip(ids[1]).unwrap().source_channel, Some(1));
        // Two tracks now (original + one new), source untouched.
        assert_eq!(p.tracks.len(), 2);
        assert_eq!(p.sources[0].channels, 2);
        assert_eq!(p.validate(), Ok(()));
    }

    #[test]
    fn undo_redo_reverses_a_scripted_sequence() {
        // FR-4.7: 20 mixed operations fully reverse to the initial state.
        let (mut p, track_id, clip_id) = project_with_clip();
        let initial = p.clone();
        let mut hist = History::new(100);

        // Apply 20 mixed edits, snapshotting before each.
        for i in 0..20u64 {
            hist.snapshot(&p);
            match i % 4 {
                0 => p.set_clip_gain(clip_id, i as f32).unwrap(),
                1 => p.set_track_gain(track_id, -(i as f32)).unwrap(),
                2 => p.trim_clip_end(clip_id, 1_000 + i * 100).unwrap(),
                _ => {
                    p.add_track(format!("t{i}"));
                }
            }
        }
        assert_ne!(p, initial);

        // Undo all 20 -> back to the initial project (deep equality).
        for _ in 0..20 {
            assert!(hist.undo(&mut p));
        }
        assert_eq!(p, initial);
        assert!(!hist.undo(&mut p));

        // Redo all 20 -> forward again.
        for _ in 0..20 {
            assert!(hist.redo(&mut p));
        }
        assert_ne!(p, initial);
    }

    #[test]
    fn new_edit_clears_redo_future() {
        let (mut p, _t, clip_id) = project_with_clip();
        let mut hist = History::new(10);
        hist.snapshot(&p);
        p.set_clip_gain(clip_id, 3.0).unwrap();
        assert!(hist.undo(&mut p));
        assert!(hist.can_redo());
        // A fresh edit invalidates redo.
        hist.snapshot(&p);
        p.set_clip_gain(clip_id, -3.0).unwrap();
        assert!(!hist.can_redo());
    }
}
