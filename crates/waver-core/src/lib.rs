//! Core types for Waver: the non-destructive project model and the audio-engine
//! boundary.
//!
//! This crate deliberately contains **no** audio I/O. It owns the pure data model
//! (spec §3) and defines the [`AudioEngine`] trait (spec §4.2) that a concrete
//! backend — `NativeEngine` (cpal), or a future `WebEngine` — implements. Keeping
//! the boundary here means the timeline/editing logic never depends on a specific
//! audio backend.

pub mod engine;
pub mod model;

pub use engine::{
    AudioEngine, ChannelLevel, DeviceDirection, DeviceInfo, EngineError, HostInfo, MeterUpdate,
    StreamParams,
};
pub use model::{
    Clip, FadeCurve, FadeSpec, ModelError, PeakPyramid, Project, Source, Track, ValidationError,
};
