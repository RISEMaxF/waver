# Manual QA checklist

Items that need **your** hands-on validation (physical hardware, listening, or visual
inspection) because they can't be fully automated in CI or this dev environment.
Everything here has automated coverage for the _software_ path; what's listed is the
end-to-end / analog / perceptual sign-off.

Legend: ⬜ not yet checked · ✅ passed · ❌ failed (add notes)

---

## M2 — Clean recording

- ⬜ **FR-2.3 loopback bit-transparency (RELEASE-BLOCKING).**
  Route your interface's output into its input (physical loopback or a virtual device
  like BlackHole). Play a known WAV out and record it. Then run the analyzer:
  `cargo run -p waver-engine --example loopback_analyze -- <reference.wav> <recorded.wav>`
  (added in M2). Expect: cross-correlation ≥ 0.999 at the alignment lag and level match
  within quantization error. The _software_ write path is already proven bit-exact by
  `capture.rs` unit tests; this validates the full analog chain adds no DSP.
- ⬜ **FR-2.4 multichannel with a real ≥4-channel interface.**
  Feed distinct tones to distinct channels; record; confirm each channel of the WAV
  holds the correct tone (open in Audacity / ffprobe). Automated tests cover the
  interleaving/writer with synthetic data only.
- ⬜ **FR-2.2 30-minute streaming memory bound.**
  Record for 30 min; confirm app RSS growth < 200 MB (proves streaming, not RAM
  accumulation) and the file opens with correct duration/rate/channels.

---

<!-- Later milestones append below. -->
