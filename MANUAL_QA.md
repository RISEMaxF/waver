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

- ⬜ **Device unplugged mid-recording (partial — full UX is M8/NFR-5).**
  If you pull the interface while recording, the WAV is finalized (valid) and the
  take is preserved (retrievable), but the timeline won't auto-place it and there's
  no on-screen "device lost" notice yet — that lands in M8. Confirm the file exists
  and is playable; the polished handling is tracked for M8.

---

## M3 — Waveforms

- ⬜ **FR-3.2 waveform matches a reference.** Record (or import) a known file, open it
  in Audacity, and compare the rendered Waver waveform shape to Audacity's for the
  same file. They should match visually. Peak math is unit-tested; this is the visual
  cross-check.
- ⬜ **FR-3.2/3.3 zoom & scroll feel.** Zoom from whole-file to sample-adjacent
  (Ctrl/Cmd + scroll) and horizontal-scroll; confirm it stays smooth and the playhead
  under the cursor keeps its timeline position while zooming.
- ⬜ **FR-3.3 playhead sync** — deferred: real playback is M6, so for now the playhead
  is a click-to-set scrub position only. A/V sync sign-off happens in M6.

---

<!-- Later milestones append below. -->
