# Waver

A native-quality, **non-destructive** audio recorder and multitrack clip editor for
Windows, macOS, and Linux — built on **Tauri v2** (Rust core + React/TypeScript UI).

Two first-class use cases:

1. **Recorder** — capture clean, _unprocessed_ audio from an external interface
   (modular synth, turntable, line-level sources), including multichannel input.
2. **Editor / comper** — a Premiere-style timeline: multiple clips per track,
   drag-and-drop arrangement, razor cuts, splits, fades, channel splitting, and
   mixdown export.

The motivating constraint is **audio fidelity on capture**: the input path applies
zero DSP (no AGC, no noise suppression, no resampling unless explicitly requested).
That is why this is a native app rather than a browser `getUserMedia` PWA.

## Architecture

- **`crates/waver-core`** — audio engine + data model. Owns all sample buffers.
  Defines the `AudioEngine` trait (the boundary that keeps a future Web Audio engine
  possible) and the non-destructive project model (`Project` → `Track` → `Clip` →
  `Source`).
- **`src-tauri`** — the Tauri v2 backend. Exposes `#[tauri::command]`s and streaming
  `Channel`s to the frontend.
- **`src/`** — React + TypeScript + Vite frontend. Holds **no raw sample data** —
  only waveform peaks and metadata.

See the requirements spec for milestones (M0–M8) and per-feature Definitions of Done.

## Prerequisites

- [Rust](https://rustup.rs/) (stable; pinned via `rust-toolchain.toml`)
- [Node.js](https://nodejs.org/) 20+
- Platform WebView deps per the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)

## Develop

```sh
npm install
npm run tauri dev      # launch the app with hot-reload
```

## Test & lint

```sh
cargo test --workspace           # Rust unit/integration tests
cargo fmt --all --check          # formatting
cargo clippy --workspace -- -D warnings
npm run typecheck                # frontend type-check
```

## License

Dual-licensed under **MIT OR Apache-2.0**. Dependency licenses are audited in CI via
`cargo-deny` (see `deny.toml`).
