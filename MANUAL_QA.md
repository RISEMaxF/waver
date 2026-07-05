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

## M4 — Timeline editing

- ⬜ **Interactive editing feel.** With a few takes recorded: drag clips (time + across
  tracks), drag edges to trim, razor-split at the playhead (S), delete (with ripple
  toggle), split channels, undo/redo (Cmd+Z / Cmd+Shift+Z). Confirm snapping to grid /
  clip edges / playhead feels right and edits are reversible. (Model logic is unit-
  tested incl. a 20-op undo reversal; this is the interaction/feel check.)
- ⬜ **FR-4.3 split sample-accuracy on export** — verified in M7 (the split halves must
  export identical to the un-split clip). Model contiguity is unit-tested now.

## M5 — Fades & gain

- ⬜ **FR-5.1 fades audible in playback/export** — verified in M6/M7. The envelope math
  (incl. equal-power constant-power ±0.5 dB) is unit-tested now; drag the fade handles
  (top corners of a clip) or use the inspector and confirm the curve shape renders.
- ⬜ **FR-5.2 gain measured in export** — verified in M7 (a +6 dB clip gain must measure
  +6 dB in the mixdown). The dB→linear math is unit-tested now.

---

## M6 — Playback

- ⬜ **FR-6.1 transport + mixdown correctness.** Record a couple of takes, press Play
  (▶ or space), Pause, Stop; click the timeline to move the playhead and play from
  there. Confirm all non-muted tracks play time-aligned, mute/solo and clip/track gain
  take effect, and fades are audible. (Mixer math — sum, +6 dB doubles, mute/solo,
  gain composition — is unit-tested; live playback + position tracking verified on the
  built-in output.)
- ⬜ **FR-6.2 A/V sync ≤ 1 frame.** During a ~5-min playback, confirm the moving
  playhead stays visually aligned with the audible output (≤ 1 frame at 60 fps). The
  reported position tracks the output callback (measured ~10 ms = output-buffer latency
  on the built-in device); verify perceptually on your interface.
- Note: playback requests the project sample rate on the output device; if the device
  can't honor it, pitch/sync could drift (resampling is M7). Loop-region playback is
  wired in the engine but not yet exposed in the UI.

---

<!-- Later milestones append below. -->
