# Waver — Definitive UX, Visual Design & Information-Architecture Audit

*A non-destructive, milestone-gated Tauri + React + Rust audio recorder/editor. Audit scope: the shipped feature surface, the control map that drives it, and confirmed findings across UX, graphical design, and information architecture. Source of truth: the verified feature inventory and verified findings; nothing here is invented beyond them.*

---

## 1. Executive summary

**What Waver is.** Waver is a desktop multitrack recorder/editor built as a Tauri shell (Rust `waver-core` / `waver-engine` behind Tauri commands) with a React + HTML-canvas front end. It records the open input to 32-bit float WAV takes, arranges them non-destructively on a canvas timeline of fixed-height lanes, and offers per-clip trim/split/fade/gain plus a per-track mixer (gain, mute, solo, record-arm). A media pool acts as a reusable clip bin, projects save/load as JSON (`.wvproj`), and a mixdown exports to WAV/FLAC/OGG. Devices, sample rate and buffer are chosen in a gear popover; a light/dark theme toggle and a single inline SVG icon system round out the chrome. The clean-capture guarantee (FR-2.3) is release-blocking.

**Overall verdict.** The engineering substrate is strong and the interaction model is coherent in the common case: the transport morphs Play/Pause correctly, recording auto-creates a track, the live waveform overlay is a genuinely nice touch, and the app is already token-driven and theme-aware in most places. But the product has a **thin information layer and an incomplete safety layer wrapped around a capable engine.** Two independent, silent, unrecoverable data-loss paths exist — wiping the whole project via New/Open with no dirty guard (F1), and destroying an in-progress take by nudging a device control mid-record (F2) — and both land squarely on the release-blocking capture guarantee. Meanwhile the track header, inspector, media pool, and ruler withhold facts the model already has in hand (names you can't edit, colors you can't set, sample rate / mono-stereo / duration / peak level never shown), which is exactly the set of details the user explicitly asked for.

**Top themes.**
1. **Silent, unrecoverable loss.** The most destructive actions carry the weakest guards (F1, F2); the safety friction that does exist is applied to the *reversible* action instead (F35).
2. **The model knows more than the UI shows.** `Clip.name`, `Source.channels/sample_rate/frames`, the peak pyramid, and `project.sample_rate` all exist end-to-end but are stripped at the view boundary or simply never rendered (F8–F12, F29–F33, F42–F44). This is the heart of the user's "tracks should show details" request.
3. **Identity is positional and ephemeral, not owned.** Track color is derived from array index and never persisted; track names are auto-generated and read-only; clips are unlabeled rectangles (F9, F8/F21, F11).
4. **Theme/token contract has holes.** Fades hardcode dark-theme colors, clip fills use one fixed 22% alpha for both themes, the type scale collapses to two tiny rungs, primary sliders are raw OS widgets, and one blue means five things (F3–F7, F22).
5. **Keyboard and navigation are under-built.** The canvas is mouse-only despite `role="application"`, there's no scrollbar/fit, no Record/Stop shortcut, and Space double-fires after a button click (F15, F16, F20, F36).

---

## 2. Comprehensive feature description

### Recording & transport
The transport is a compact toolbar on the canvas. A single button morphs between **Play** and **Pause** — it shows Play when idle and Pause while `playing && !paused`, and Space toggles the same states (Play when stopped, pause/resume when running). **Stop** is a separate square button, enabled only while playing, that drops the backend playback session. There is **no monitoring/passthrough** anywhere — you cannot hear your live input; monitoring is visual only. Clicking the canvas **seeks/scrubs**: a click moves the playhead, a drag scrubs live, and if audio is playing the seek re-issues `play()` from the new frame. Two automatic behaviors help re-takes: the playhead **tracks the audible position** during playback via a `requestAnimationFrame` poll, and on natural end it **returns to the frame where playback began** so pressing Play again replays the same passage.

**Recording** is a start/stop toggle in the top bar showing a red dot + "Rec" idle and a square + running `m:ss` timer while capturing; it is disabled until an input device and sample rate are chosen. Each track carries a red **"R" arm** toggle (single-arm); if nothing is armed at record time the backend auto-creates a track ("record makes a track"). The take lands at the current **playhead frame** on the armed track, with the front end mirroring the target to the backend continuously (except while playing/recording) and committing it synchronously right before start to avoid a scrub/arm race; overlaps append after the last clip. While recording, a **live min/max waveform overlay** with a moving cursor is drawn on the armed lane, auto-scaled to the running peak.

### Timeline editing
The timeline is a single HTML canvas of fixed-height (88px) lanes under a 22px ruler. Clips can be selected, moved, trimmed at either edge, split at the playhead, and given fade-in/fade-out with a curve shape (linear → equal-power → log) cycled by double-clicking the 22px fade zone. Cut/Copy/Paste/Duplicate/Delete operate on the selected clip; edits flow through an undoable history. Navigation is wheel-based: plain wheel pans, Ctrl/Cmd+wheel zooms; toolbar buttons add tracks and zoom. An optional **beat grid** draws bar/beat/step lines at a real BPM.

### Tracks & mixer
Each track has a left-gutter header (190px) aligned 1:1 with its lane: a 5px identity color strip, an (ellipsized, read-only) name with a delete ×, an **R/M/S** row (arm / mute / solo), and a **gain slider** (−24…+12 dB, step 0.5) with a dB readout. Mute excludes and dims a track; solo dims all non-soloed tracks; delete asks for confirmation with a clip count. Track gain is also editable from the Inspector when a clip is selected. **Track color is derived from positional index** through an 8-color palette — not stored, not editable, reassigned on reorder/delete.

### Media pool & projects
The **media pool** is a reusable clip bin: **Add** imports audio files (transcoded to scratch WAVs) without placing them; pooled sources are **dragged onto the timeline** to create clips (droppable many times); the pool **collapses** to a rail and lists each source with basename, duration in seconds, and channel count. Recordings and imports both appear here, and **sources can never be removed**. Projects support **New / Open / Save / Save As** (pretty JSON, atomic write, remembered path, missing-source reporting) and a direct **Import** that places a file on the timeline.

### Devices, export & theme
A gear popover hosts the **DeviceSelector**: input device, sample rate (kHz), buffer frames, output device, and **Rescan**. Selections persist via `save_settings` and re-open the metering stream. A per-channel **input meter** shows an RMS fill + instantaneous peak tick, a decaying **peak-hold**, and a **clip latch** reset by clicking the meter; numeric dBFS and channel number render only in the non-compact mode that the app never mounts. **Export** picks format (WAV/FLAC/OGG) and bit depth (16/24/32f, disabled for OGG) and mixes down to 2 channels at the project rate. A **theme toggle** flips `data-theme` on `<html>` (default dark, not persisted). All icons come from one inline stroke-based SVG set.

---

## 3. Feature → control map

| Feature | Control (component · affordance · shortcut/gesture) | Backend |
|---|---|---|
| Play | WaveformTimeline transport `<button class="transport play">` IconPlay, aria "Play", title "Play (space)"; **Space** when not typing | `invoke("play",{deviceId,fromFrame,loopStart:null,loopEnd:null})` → Rust `play()` → `waver_engine::start_playback` |
| Pause / resume | SAME `.transport play` button → IconPause when `playing && !paused`; `onClick = playing ? togglePause : startPlay`; **Space** toggles when playing | `invoke("pause_playback",{paused})` → `Playback::set_paused` |
| Stop | `<button class="transport stop">` IconStop, `disabled={!playing}`; no shortcut | `invoke("stop_playback")` → drops Playback session |
| Seek / scrub | Canvas `role="application"`: `onMouseDown` seek, `onMouseMove` live scrub, `onMouseUp` settle; click/drag gesture | While playing, re-`invoke("play")` from new frame; stopped = local only |
| Auto-return at end | none (automatic) — `useTransport` poll returns to `playStartFrame` | `invoke("playback_status")` → `{playing,paused,position_frames}` |
| Playhead tracking | none — rAF poll drives `setPlayheadSec` | `invoke("playback_status")` |
| Record start/stop | AudioControls `<button class="rec-btn start|stop">`; dot+"Rec" / square+timer; `disabled={!audio.canRecord}`; no shortcut | `invoke("start_recording")` / `invoke("stop_recording")` → writes `take-NNN-*.wav`, `add_recording` |
| Arm track (R) | TrackHeaders `<button class="ts-btn arm">` "R", `aria-pressed`; no shortcut | `invoke("set_record_target",{trackId,startFrame})`; frontend `armedTrackId` only |
| Record-from-playhead | none — derived from playhead; committed pre-start | `invoke("set_record_target")`; `stop_recording` resolves overlap |
| Live record waveform | none — `recWave` buckets from meter stream | `MeterUpdate` stream from `open_input` Channel |
| Add track | wave-toolbar `<button class="tbtn">` IconPlus "Track"; also empty-timeline drop; no shortcut | `add_track` → `Track::new`; snapshots History |
| Mute (M) | TrackHeaders `<button class="ts-btn mute">` "M", `aria-pressed` | `set_track_muted` → `apply_edit` → `Project::set_track_muted` |
| Solo (S) | TrackHeaders `<button class="ts-btn solo">` "S", `aria-pressed` | `set_track_soloed` → `apply_edit` → `Project::set_track_soloed` |
| Delete track | TrackHeaders `<button class="track-remove">` IconClose; native `ask()` confirm | `remove_track` → `apply_edit` → `Project::remove_track` |
| Track gain | TrackHeaders `<input type=range min=-24 max=12 step=0.5>` + readout; also Inspector `#insp-track-gain`; no shortcut | `set_track_gain` → `apply_edit` → `Project::set_track_gain` |
| Track color | 5px `.track-color-strip` (header) + canvas clip tint; **no control** | none — `renderer.ts trackColor(index)`, not persisted |
| Clip gain / fades | Inspector `#insp` ranges/number/select (gain, fade-in, fade-out, curve); canvas double-click cycles curve | clip-edit commands via `apply_edit` |
| Input device | DeviceSelector `<select id="input-device">` (via AudioControls gear IconGear) | `list_devices` populate; `save_settings`; `open_input` re-open |
| Output device | DeviceSelector `<select id="output-device">` | `list_devices`; `save_settings`; id → `play` |
| Sample rate | DeviceSelector `<select id="sample-rate">` (kHz), disabled if no rates | `StreamParams.sample_rate` → `open_input`; `save_settings` |
| Buffer size | DeviceSelector `<select id="buffer-size">` (Default/64…2048) | `StreamParams.buffer_frames` → `open_input` |
| Rescan | DeviceSelector `<button class="tbtn">` IconRefresh | `list_devices` (non-dirty re-resolve) |
| Input meter | Meter (compact) in AudioControls: `.meter-rms`/`.meter-peak`/`.meter-hold`/`.meter-clip`; click meter resets | `MeterUpdate` (`ChannelLevel{peak_dbfs,rms_dbfs}`); holds/latch client-side |
| Pool: add | MediaPool `<button class="tbtn">` IconPlus "Add"; native multi-select | `invoke("import_to_pool",{path})` per file |
| Pool: drag to track | `div.pool-item` draggable (`application/x-waver-source`) → canvas `onDrop` | `api.paste(spec,trackId)` → `paste_clip`; empty timeline → `add_track` |
| Pool: collapse | `.pool-toggle` IconChevronLeft/Right | none (React state) |
| New / Open | FileBar `.tbtn` IconNew / IconOpen | `new_project` / `load_project` (returns missing_sources) |
| Save / Save As | FileBar `.tbtn` IconSave (remembered path) / IconSaveAs | `save_project` (atomic temp+rename) |
| Import to timeline | FileBar `.tbtn` IconImport; single-select | `import_audio` (FR-7.1) |
| Export format / depth | FileBar `<select>` format (WAV/FLAC/OGG) + bit-depth (disabled for OGG) | `req.format`/`req.bit_depth` |
| Export mixdown | FileBar `.tbtn` IconExport, `disabled={busy||!hasContent}` | `export_project` (FR-7.2/7.3), 2ch, project rate |
| Theme toggle | FileBar `.tbtn icon-only theme-toggle` IconSun/IconMoon | none — sets `documentElement.dataset.theme` |

---

## 4. UX audit

> Confirmed findings whose dimension is UX. Severities and F-numbers preserved. Findings F13–F44 that are UX-tagged appear here; the two data-loss HIGHs lead.

### F1 · [HIGH] New/Open silently discard the entire project with no unsaved-changes guard
*Top bar / File menu · `FileBar.tsx:68`*
- **Observation.** New calls `newProject()` and Open calls `loadProjectDialog()` immediately; the backend `new_project`/`load_project` unconditionally replace the project and reset History. There is no dirty flag anywhere, so a single misclick destroys all takes and edits, and Undo cannot recover across the reset.
- **Why it matters.** The most destructive action carries the weakest safeguard — violating Nielsen #5 (Error Prevention) and #3 (User Control & Freedom, since the undo escape hatch is itself destroyed). It also breaks the app's own confirm convention (delete-track already prompts). For a release-blocking clean-capture product, silent loss of recordings is severe.
- **How others do it.** Reaper keeps a dirty flag (`*` in the title) and pops Save/Don't Save/Cancel on New/Open/close; Ableton Live raises the same dialog and reflects unsaved state in the title; Pro Tools/Logic/GarageBand ride the macOS document-dirty sheet. The named pattern is the **document dirty-state flag** (title asterisk + save-before-discard prompt).
- **Amendment.** Add `dirty` to `useProject` (set true inside `run` after any successful edit; cleared on Save/Save As/New/Open). In FileBar, gate New and Open behind the same `ask()` warning the delete-track path uses; on confirm proceed then `markClean()`. Surface a `•`/`*` in `filebar-project` and the Tauri window title; optionally register `onCloseRequested`.
- **Definition of Done.** Dirty flips true after any edit and false after Save/Save As/New/Open; with `dirty`, New and Open show a warning confirm whose Cancel leaves project + history intact and whose OK proceeds; with `!dirty` no nuisance prompt; a visible unsaved indicator appears and clears on Save; the guard reuses `@tauri-apps/plugin-dialog ask`.

### F2 · [HIGH] Changing device / sample-rate / buffer mid-recording silently aborts the take
*Device settings / Recording · `useAudio.ts:159`*
- **Observation.** The `openInput` effect cleanup runs on any `inputId/sampleRate/bufferFrames/selectedInput` change; it force-clears `recording`, closes the input, and never finalizes the WAV. Because the gear popover is reachable during recording, nudging any setting silently tears down capture and loses the in-progress take.
- **Why it matters.** Silent, unrecoverable loss of a live take is the worst failure for a recorder and lands on release-blocking FR-2.3. A performer reaching for buffer size to fix glitches destroys the very take they're saving. Violates Nielsen #5, #1 (Visibility), #9 (Error recovery), and #3.
- **How others do it.** Pro Tools locks device/buffer/sample-rate while the transport runs (the Playback Engine dialog won't even open); Ableton halts the transport to reinit the driver but commits already-recorded audio. Best practice: **disable engine-config controls during an in-progress operation.**
- **Amendment.** (1) Thread `recording` into DeviceSelector and `disabled={recording}` the selects + Rescan; early-return `select*/refresh` when `recordingRef.current`. (2) Harden the cleanup: if recording at teardown, `await stopRecording()` to finalize + push to `takes`, then `closeInput()`, with a visible notice banner.
- **Definition of Done.** During a take the gear controls are disabled; programmatic `select*/refresh` do not tear down the stream; a forced teardown finalizes the WAV, adds a `takes[]` entry, and shows a banner; automated tests cover `startRec()→selectRate()` (stays recording) and a forced cleanup (takes +1, notice set).

### F13 · [MEDIUM] Disabled Play and Record buttons give no reason why they are inert
*Transport / Recording · `WaveformTimeline.tsx:977`*
- **Observation.** Play (disabled on no output/no project/zero tracks) keeps title "Play (space)"; Record (disabled until `canRecord`) keeps title "Record". Export, by contrast, already switches to "Record or import something first" — so the pattern exists but isn't applied to the two most important buttons.
- **Why it matters.** A first-run user with no device sees two greyed buttons and no path to the gear popover — Nielsen #1, #9, and #4 (inconsistent with Export). Screen-reader users get only "Play"/"Record".
- **How others do it.** Reaper routes a disabled Record toward Preferences > Audio; Ableton shows "The audio engine is off"; WAI-ARIA/Nielsen guidance says a control disabled for a fixable reason must name that reason via title + accessible name.
- **Amendment.** Compute a `playReason`/`recReason` string and feed both `title` and `aria-label` when disabled (naming the gear popover); optionally open the DeviceSelector when a device-less button is clicked.
- **Definition of Done.** Each disabled precondition (no output, no project, zero tracks, no input, no sample rate) yields a specific title + matching aria-label; enabled states revert to the normal tooltips; an RTL test covers each combination.

### F14 · [MEDIUM] Imported/recorded sources can never be removed from the media pool
*Media pool · `MediaPool.tsx:55`*
- **Observation.** The pool has only Add + read-only rows; no remove affordance and no backend command to drop a Source. Every import and take piles up forever, bloating saved JSON and the bin.
- **Why it matters.** No emergency exit for a mistaken import or throwaway take (Nielsen #3, #7). 30 takes to keep 3 leaves 27 dead sources; persisted paths can even trigger false "missing source" warnings.
- **How others do it.** Pro Tools Clip List Clear (+ "Select Unused"); Reaper "Clean current project directory"; Ableton Collect-and-Save unused-file report. Best practice: per-item remove, "remove vs delete file" distinction, confirmation, and batch "remove unused".
- **Amendment.** Add a guarded `remove_source(id)` command (refuse if any clip references it; undoable), a `remove_unused_sources()`, and a hover/focus Remove button + Delete-key handler on pool rows, with confirm for referenced/delete-file variants.
- **Definition of Done.** `remove_source` registered and removes from `project.sources`; referenced-source removal rejected or confirmed with no dangling `source_id`; rows show Remove on hover and respond to Delete; removal is undoable; "Remove unused" clears exactly the unreferenced set; no false missing-source warnings.

### F15 · [MEDIUM] Timeline editing is entirely mouse-only; no keyboard access to clips
*Clip editing / Accessibility · `WaveformTimeline.tsx:1205`*
- **Observation.** The canvas is `role="application"` but not focusable (no `tabIndex`) and has no key handlers; select/move/trim/fade are mouse hit-test only. The window keydown handler covers undo/redo/clipboard/split/delete/space but requires a prior mouse selection. No clip-to-clip navigation, no frame nudge, no Home/End.
- **Why it matters.** Hard accessibility blocker — the entire editing surface is unreachable without a mouse, failing WCAG 2.1.1 (Keyboard) and 2.4.3 (Focus Order); `role="application"` actively suppresses AT reading mode. Frame-accurate keyboard editing is also faster for sighted power users.
- **How others do it.** Reaper (arrow/Tab item nav, Home/End, bindable trims), Pro Tools (Tab/Tab-to-Transient, nudge, Home/End), Ableton (arrow nav/nudge). WAI-ARIA APG: `role="application"` obligates full keyboard interaction.
- **Amendment.** `tabIndex={0}` + a drawn focus ring; scope the key handler to the focused timeline; Arrow = prev/next clip, Up/Down = adjacent track, Alt+Arrow = 1-frame nudge (Shift+Alt = grid), Home/End = project start/end; fix the ARIA (activedescendant or downgrade role); reuse `splitAtPlayhead/api.move/trimStart/trimEnd`.
- **Definition of Done.** Tab focuses the canvas with a visible ring; arrows select/move clips and announce selection; nudge shortcuts move by exactly one frame/grid unit undoably; Home/End move the playhead; all existing shortcuts work after keyboard-only selection; axe check passes; a full keyboard-only select→move→trim→delete walkthrough works with zero mouse events.

### F16 · [MEDIUM, plausible] Space toggles the transport twice when a toolbar button holds focus
*Transport / Keyboard · `WaveformTimeline.tsx:961`*
- **Observation.** The window handler intercepts Space, but a just-clicked button retains focus; the next Space fires both the window handler and the button's native activation on keyup (`preventDefault` on keydown doesn't stop it), so the first Space after any click appears to no-op (Play) or silently mutates (Track).
- **Why it matters.** Space is the most-used transport key; the same press produces different results depending on invisible focus (Nielsen #4, predictability, #3). Mouse-then-keyboard is the dominant rhythm, so this hits constantly and is near-impossible to diagnose.
- **How others do it.** Ableton/Pro Tools/Reaper dispatch transport globally, decoupled from the focused control. Web remedies: blur-on-click (`onMouseDown` preventDefault) and gate global shortcuts on `activeElement`.
- **Amendment.** Add `onMouseDown={(e)=>e.preventDefault()}` to transport/toolbar buttons; in the Space branch, blur any focused `HTMLButtonElement` before toggling.
- **Definition of Done.** One Space = exactly one transport change after clicking Play/Stop/Track/Split/Zoom (no second track, no split/zoom side-effect); `activeElement` is never a toolbar button right after a click; text-input Space still passes through; automated tests assert single `startPlay`/`togglePause` and unchanged `addTrack`.

### F17 · [MEDIUM] Stop leaves the playhead in place but natural end rewinds it
*Transport · `useTransport.ts:50`*
- **Observation.** `stopPlay` clears state but never resets position, while natural end returns to `playStartFrame`. The same "stopped" state ends at two different positions, and there's no explicit return-to-zero control (only clicking the canvas at x=0).
- **Why it matters.** Users can't predict post-Stop position (Nielsen #4) and the near-universal "Stop = return to start marker" model is broken — costly for the release-blocking re-take/clean-capture loop, where the user must pixel-hunt the start each time.
- **How others do it.** Pro Tools returns to the play-start marker (toggle-governed); Ableton/Logic use two-press Stop (last start, then bar 1); Reaper's "Move edit cursor to start of playback on stop" + Home. Common thread: deterministic stop position + explicit return-to-start.
- **Amendment.** In `stopPlay` call `onPosition(playStartFrame/sr)` (shared helper with the end branch); expose `returnToStart` = `seek(0)`; adopt the two-press rule; drop `disabled={!playing}` on Stop (or add a rewind button) and bind Home.
- **Definition of Done.** Interrupted Stop lands at the same frame as natural end for a non-zero start; a return-to-start exists via button and Home; two-press Stop rewinds to 0; Stop isn't permanently disabled when idle; Play after any Stop replays from the take start.

### F18 · [MEDIUM] Clicking a clip to select it force-moves the playhead and restarts playback
*Clip editing / Transport · `WaveformTimeline.tsx:644`*
- **Observation.** Clip-body `onMouseDown` calls `seek(clickedSec)` before arming the move-drag; `seek` re-issues `play()` when playing. So you cannot select a clip (to read the Inspector, tweak gain, split) without jumping the playhead and, mid-playback, audibly restarting the mix.
- **Why it matters.** A small gesture causes a large state change (Nielsen #3, #4, #1, Least Astonishment) and defeats auditioning a gain tweak against a steady position.
- **How others do it.** Pro Tools separates by tool (Grabber selects without moving the cursor); Ableton single-click selects in place; Reaper left-click selects without stopping playback. Best practice: transport-seek belongs to the ruler/scrub gesture, clip-body clicks are pure selection.
- **Amendment.** Remove the `seek(...)` in the clip-body branch; keep click-to-seek on the ruler/empty-arrange path (optionally restrict to `y < RULER_HEIGHT`); gate any seek-on-clip behind a modifier.
- **Definition of Done.** Clicking a clip while stopped selects without moving the playhead; while playing, selection continues audio uninterrupted with zero new `play()` calls; move-drag still works; ruler seek unchanged; a regression test asserts `onPosition/playStartFrame` unchanged and `play()` not called on a body click.

### F19 · [MEDIUM] Fade-curve editing is hidden behind an undiscoverable double-click on a 22px zone
*Clip editing · `WaveformTimeline.tsx:729`*
- **Observation.** The only on-canvas way to change a fade curve is double-clicking inside the 22px `FADE_ZONE_PX` (cycling linear → equal-power → log). Nothing signals it's double-clickable and the cursor is plain "pointer". The Inspector's curve dropdown partly mitigates it, but the two paths are unlabeled duplicates and the canvas gesture is effectively invisible.
- *(Motivation, cross-reference, amendment and DoD were not populated in the verified findings for F19; recorded here as observation-only. Recommended direction: add a visible cursor/handle affordance on the fade zone and label the two paths so the gesture is discoverable rather than hidden.)*

### F20 · [MEDIUM] No horizontal scrollbar; pan and zoom are wheel-only
*Timeline navigation · `WaveformTimeline.tsx:801`*
- **Observation.** Navigation lives entirely in `onWheel` (wheel pans, Ctrl/Cmd+wheel zooms). No scrollbar, no fit-to-content/zoom-to-fit, no jump-to-end; `scrollSec` can only be nudged, never dragged; no Home/End/Arrow keys.
- **Why it matters.** Nothing communicates scroll position or total length (Nielsen #1), the pan/zoom gestures are invisible (#6), and keyboard users cannot scroll at all — for projects that exceed a viewport, direct navigation is table stakes.
- **How others do it.** Reaper (draggable bottom scrollbar + zoom-to-fit + Home/End), Audacity (scrollbar + Fit-to-Width), Pro Tools (scrollbar + zoomers + go-to-start/end), Ableton/Logic overview strips. Best practice: WAI-ARIA `role="scrollbar"` thumb + a zoom-to-fit affordance.
- **Amendment.** Derive `contentSec`/`viewportSec`, clamp `scrollSec` to `[0, contentSec−viewportSec]`; render a custom `role="scrollbar"` thumb (position/width from ratios, pointer-drag → `setScrollSec`); add Fit and Go-to-end buttons and Home/End/Arrow key branches.
- **Definition of Done.** Scrollbar visible when content exceeds viewport; thumb drag sets `scrollSec` and reflects the ratio bidirectionally; `scrollSec` clamped both ends; Fit fills the viewport with `scrollSec=0`; Go-to-end works; Home/End/Arrows navigate (not while a toolbar input is focused); scrollbar exposes `aria-valuenow/min/max`; a horizontal-wheel-less mouse can reach any point via visible controls.

### F21 · [MEDIUM] Tracks cannot be renamed despite the name being their primary identifier
*Track headers · `TrackHeaders.tsx:53`*
- **Observation.** The name is a read-only ellipsized `<span>` with a title tooltip; no rename control anywhere; `Track.name` is only ever auto-generated. Clips *can* be renamed (`setClipName` exists) but tracks cannot — an internal inconsistency.
- **Why it matters.** The track name is the primary human identifier; with only "Track 3"/"Take 2" users track identity by memory and position (Nielsen #6, #2, #4). Rename is a baseline DAW expectation.
- **How others do it.** Ableton (double-click / Cmd+R inline), Reaper (double-click TCP name), Pro Tools (double-click nameplate), Audacity (Track Menu > Name…). Convention: double-click-to-edit inline, commit on Enter, cancel on Escape.
- **Amendment.** Mirror the clip-rename path end-to-end: `set_track_name` in `edit.rs` → Tauri command → `project.ts`/`useProject` API → dual-mode span/input in TrackHeaders (double-click / Enter-F2, autofocus+select-all, commit on Enter/blur, cancel Esc, reject empty), keeping the gain-slider aria-label in sync.
- **Definition of Done.** Double-click shows a seeded input; Enter/blur persists and reflects everywhere (header, delete-confirm, aria-label); Escape cancels; empty reverts; rename is undoable/redoable via the EditOp path; keyboard-reachable (Enter/F2); backend command registered with a `waver-core` unit test.

> **Note.** F21 (UX-tagged) and **F8 (infoarch-tagged, HIGH)** are the same rename gap. The core/command/API/UI work is shared; treat them as one deliverable prioritized at the HIGH level (see §6, F8).

### F34 · [LOW] Paste button is always enabled even with an empty clipboard
*Clip editing toolbar · `WaveformTimeline.tsx:1116`*
- **Observation.** Unlike Split/Duplicate/Cut/Copy/Channels/Delete (all disable on `!selected`), Paste has no `disabled`; with a null clipboard `pasteAtPlayhead()` returns silently, so the button looks live but does nothing.
- **Why it matters.** A false affordance (Nielsen #1) that also breaks internal consistency (#4); worst for new users and at session start when the clipboard is empty.
- **How others do it.** Ableton/Reaper/Pro Tools/Logic all dim Paste until the clipboard holds material (Apple HIG / Windows guidance).
- **Amendment.** Track `hasClipboard` in state (set true in copy/cut, false when a stale source is cleared); `disabled={!hasClipboard}` with a context title ("Nothing to paste"); keep the guard for the keyboard path.
- **Definition of Done.** Paste disabled with an empty clipboard; enabled after Copy/Cut; returns to disabled when the clipboard clears; disabled tooltip explains why; Cmd/Ctrl+V stays a safe no-op; a unit test asserts the `disabled` attribute transitions.

### F35 · [LOW] Destructive-action confirmation is backwards between tracks and clips
*Clip editing / Track headers · `TrackHeaders.tsx:27`*
- **Observation.** Deleting a track pops a native confirm that itself says "This can be undone." Deleting a clip (toolbar, Backspace/Delete, Cut) destroys clips with no confirmation. Both are equally undoable — the heavier gate is on the less-destructive action.
- **Why it matters.** Two structurally identical undoable operations get opposite treatment (Nielsen #4), and a blocking modal is the wrong safety net for a reversible action (#3) while the higher-frequency clip delete has none.
- **How others do it.** Ableton/Reaper delete both scopes instantly with Cmd+Z as the net; Pro Tools prompts only because its track delete historically wasn't undoable. NN/g: gate only destructive-and-hard-to-reverse actions; prefer undo/undo-toast.
- **Amendment.** Remove the modal from the reversible track delete (`api.removeTrack(id)` directly, drop the `ask` import); optionally add a non-blocking "Track deleted — Undo" toast. (Alternative: apply one threshold-based confirm consistently to all four paths.)
- **Definition of Done.** Track delete removes without a modal, matching clip delete; a single Cmd+Z restores it (redo re-removes); no "This can be undone" string remains; all four delete paths share one policy; if a toast is added it wires to `api.undo()`.

### F36 · [LOW] No shortcut for Record or Stop; only Space maps to play/pause
*Transport / Keyboard · `WaveformTimeline.tsx:959`*
- **Observation.** The keymap binds Space→play/pause and S→split; Record is mouse-only and Stop is mouse-only (`disabled={!playing}`). Space can never *stop* — only pause.
- **Why it matters.** A recordist must reach for the mouse to arm/stop takes at the exact moments speed matters (Nielsen #7, #4, #2); arm latency touches FR-2.3 clean-capture.
- **How others do it.** Pro Tools (F12/numpad-3 record, Space/numpad-0 stop), Reaper (R record, Space stop), Audacity (R record, dedicated Stop distinct from Pause), Ableton (F9 record). Pattern: a Record accelerator + a Stop key semantically distinct from Pause.
- **Amendment.** Thread `onToggleRecord`/`stopPlay`/`recording`/`canRecord` into the `kb` ref; add `R` (guarded by `canRecord`) and a dedicated Stop key (e.g. Escape) before the Space branch, honoring the existing input-focus guard and the buttons' disabled conditions; advertise keys in tooltips.
- **Definition of Done.** R toggles record when `canRecord` (no-op otherwise); Escape stops playback/recording, no-op when idle; Space still only play/pauses; shortcuts suppressed in text inputs; tooltips advertise keys; shortcuts can't do what the button would block; covered by a jsdom/RTL keydown test.

### F37 · [LOW] Gain sliders offer no reset-to-0dB or numeric entry
*Track headers / Inspector · `TrackHeaders.tsx:96`*
- **Observation.** Track gain and clip/track gain in the Inspector are bare ranges (−24…+12, step 0.5) with read-only dB labels — no double-click-to-unity, no typed entry, so returning to 0 dB or dialing a precise value means careful dragging. The adjacent fade-length field *does* accept typed input (inconsistent).
- **Why it matters.** Unity is the most-returned-to value; step-0.5 dragging can't reliably land on 0.0 (Nielsen #7, #3, #4). Double-click-to-default is expected muscle memory.
- **How others do it.** Ableton (double-click → default + text entry), Pro Tools (Option-click reset + typed readout), Reaper (double-click reset + typed value), Logic/GarageBand (Option/double-click reset).
- **Amendment.** Add `onDoubleClick` reset-to-0 on each range; convert the dB span to a controlled numeric input (clamp, commit on blur/Enter à la the Inspector NameField); factor a shared `GainControl` used by all three sites.
- **Definition of Done.** Double-click sets exactly 0.0 dB (one set-gain call); typing commits the exact clamped value on blur/Enter (not per keystroke); out-of-range clamps, non-numeric reverts; drag/step/range unchanged; the field is keyboard-focusable and labelled.

### F38 · [LOW] Theme choice and per-session UI state are not persisted
*Top bar · `FileBar.tsx:36`*
- **Observation.** The theme toggle is local `useState` defaulting to dark, written only to the DOM — every launch resets to dark. `armedTrackId`, selection, zoom, and scroll are discarded on reload; arm has no model field. Yet device selections *do* persist, so the app teaches stickiness then drops theme/workspace state.
- **Why it matters.** The inconsistency is the harm (Nielsen #4, #3); hard-defaulting to dark also ignores the OS `prefers-color-scheme` (accessibility concern).
- **How others do it.** Reaper (theme in ini, zoom/scroll/arm in .rpp), Ableton (arm/zoom/scroll in .als, theme global), Pro Tools (arm + window/zoom with session). Two tiers: global chrome prefs restore on launch; per-document view/arm serialized with the project.
- **Amendment.** Tier 1 (minimal, high value): add `theme` to `AudioSettings` (Rust + TS), init from `loadSettings()` falling back to `prefers-color-scheme`, save on toggle. Tier 2: add `armed` to the track model and a `view {scrollSec,pxPerSec,selectedClipId}` to the project; hydrate on load; debounce a localStorage cache for crash resilience.
- **Definition of Done.** Light mode survives quit/relaunch; first launch follows the OS scheme; settings payload includes `theme`; save→reopen restores arm/selection/zoom/scroll; a mid-session webview reload restores scroll+selection.

---

## 5. Graphical design audit

> Confirmed findings whose dimension is visual/graphical.

### F3 · [HIGH] Fade rendering hardcodes dark-theme colors and ignores the existing theme token
*Clip editing / canvas fades · `renderer.tsx:161`*
- **Observation.** `drawFade` uses literal `rgba(8,10,14,0.55)` fill, `rgba(255,255,255,0.92)` curve, and `#fff` handle — all dark-baked constants — while the resolved `th.fadeFill` (`--wave-fade-fill`) token sits unused. In light mode this paints a near-black smudge plus a near-invisible curve/handle.
- **Why it matters.** Fades are the one canvas element that ignores the token contract (Nielsen consistency; the tokens.css invariant that a theme swap is "this file only"). It fails WCAG 1.4.11 (3:1 non-text) for both the curve and the interactive handle, making fade editing unusable in light theme.
- **How others do it.** Reaper (fade colors from the theme map), Audacity (theme-defined envelope line/points), Ableton (fade derived from clip color + computed contrast). Best practice / WCAG 1.4.11: derive graphical/interactive colors from tokens.
- **Amendment.** Use `th.fadeFill` at line 161; add `--wave-fade-line`/`--wave-fade-handle` tokens in every theme block, extend `CanvasTheme`, resolve in `readCanvasTheme`, and set `strokeStyle`/`fillStyle` from them.
- **Definition of Done.** No hardcoded fade literals remain; the new fields are consumed (no dead tokens); light-theme fill tints toward the surface with curve+handle ≥3:1; dark theme unchanged; runtime theme swap recolors on next repaint; tokens defined in dark root, light `[data-theme]`, and the `prefers-color-scheme` block.

### F4 · [HIGH] Track palette is hardcoded neon hex and clips draw at 22% alpha, so clips wash out (worst in light theme)
*Track colors / clips · `renderer.tsx:9`*
- **Observation.** `TRACK_COLORS` is a fixed saturated dark-tuned set; clip bodies fill at `hexA(tc,0.22)`. Over the light lane (`#eef1f4`) a 22% pastel is nearly invisible, and it clashes with the full-opacity 5px header strip so canvas and gutter never read as the same color.
- **Why it matters.** Users scan clip fills for structure and track identity (WCAG 1.4.11 ≥3:1; Nielsen consistency and recognition-over-recall). One hardcoded alpha can't be legible over both a near-black and a near-white lane.
- **How others do it.** Ableton/Reaper/Logic fill clips with a solid/near-opaque identity color, waveform on top. Best practice: composite the body color against the actual background to a fixed contrast target, not a fixed low alpha.
- **Amendment.** Add `clipFill(tc, laneColor)` that blends to a ≥3:1 target against the resolved lane in both themes; replace `hexA(tc,0.22)`; compute waveform ink to contrast; ensure gutter strip and clip fill share the same `trackColor(index)` source.
- **Definition of Done.** A unit test over all 8 palette colors asserts ≥3:1 against both lane tokens in both themes; gutter strip and clip fill are perceptually matched (small ΔE); a light-theme screenshot shows the clip *body* distinct from an empty lane; no dark-theme regression.

### F5 · [HIGH] Type scale collapses to two tiny sizes; md/xl/2xl unused, hierarchy flat
*Typography · `tokens.css:78`*
- **Observation.** The scale defines xs/sm/md/lg/xl/2xl but the app uses only xs (~11.5px) and sm (~13.6px) plus lg for one brand word; md/xl/2xl are never referenced. Nearly everything renders at two nearly identical sizes; pervasive .72rem muted instructional copy sits below comfortable legibility.
- **Why it matters.** Size is the primary pre-attentive hierarchy cue; a 2px delta across ~95% of text means every region carries equal weight (Nielsen aesthetic/minimalist; Gestalt size-encodes-importance). 11.5px muted body text pushes instructional copy toward failing legibility.
- **How others do it.** Ableton/Logic use 3+ perceptible tiers with a separate readable help tier; a modular scale (Type Scale / Material) gives caption→body→subhead→title steps. Reaper's flat default is the counter-example (a common complaint).
- **Amendment.** Add semantic aliases (caption/label/body/subhead/title) mapping to the existing rungs, set the root to `--text-body` (16px), re-point `.pool-empty`/`.filebar-msg`/`.devsel label` up to sm/md, promote region headers to lg/xl; optionally a CI guard against zero-reference tokens.
- **Definition of Done.** ≥4 font-size tokens referenced; no defined `--font-size-*` has zero references; base body ≥16px and none of the cited muted rules compute to 11.52px; a screenshot shows ≥3 perceptible sizes (adjacent tiers ≥~3px apart); no muted text at xs; no layout overflow.

### F6 · [HIGH] Primary gain and fade sliders are unstyled native range/number inputs
*Track headers / Inspector controls · `App.css:943`*
- **Observation.** The most-used continuous controls (track gain, clip gain, fade length) are raw `<input type=range>`/`<input type=number>` with no appearance styling; they ignore `--color-accent`, don't reflect track color, and differ across macOS/Windows and light/dark inside an otherwise fully custom system. Inspector number/select inputs are also a different size class than the 30px toolbar controls.
- **Why it matters.** OS-default widgets inside a token-driven UI break Nielsen consistency and aesthetic/minimalist; tiny native thumbs mis-price Fitts's Law on the most-dragged controls; the app reads as two visual languages.
- **How others do it.** Ableton/Reaper/Logic/Pro Tools draw faders themselves, adopting theme accent and track color. Standard web technique: `appearance:none` + styled `::-webkit-slider-*`/`-moz-*`, or `accent-color` as a one-line minimum.
- **Amendment.** Global `accent-color: var(--color-accent)` baseline; a `.control-range` class with themed pseudo-elements and `--track-color` thumb tint; bump fade-length inputs and curve select to the shared 28–30px control metrics.
- **Definition of Done.** Sliders styled (accent-color or full pseudo-element theming, incl. `-moz-`); changing `--color-accent` recolors thumb/track/focus; each track's thumb is its identity color; number/select box heights match the 30px toolbar; keyboard focus shows an accent focus-visible ring; macOS/Windows slider geometry consistent; drag still updates gain/readout.

### F7 · [HIGH] Meter color zones contradict between the track background and the fill
*Meter · `App.css:498`*
- **Observation.** The meter track background breaks green→amber→red at 70%/90%, but the RMS fill breaks at 66%/80% and 80%/100% — three different threshold sets, so the moving bar changes color at a different height than the band it sits in, and neither is anchored to a dBFS value.
- **Why it matters.** A meter's whole job is at-a-glance "am I clipping"; contradicting scale vs. bar defeats preattentive color coding (Nielsen consistency, match-to-real-world) and "red" doesn't reliably mean 0 dBFS — bad for release-blocking clean capture.
- **How others do it.** Pro Tools/Logic/Reaper anchor zones to fixed dBFS and use one threshold set for scale and fill, with a latching clip LED at 0 dBFS. Best practice: define breakpoints once as dBFS, derive both marks and fill from them.
- **Amendment.** Collapse to one source of truth (shared `--meter-warn`/`--meter-err` or dBFS constants mapped through the same value→height function); hard-stop the fill gradients at those points in both orientations; add a latching clip state at 0 dBFS.
- **Definition of Done.** One threshold set referenced by background + both fills (no stray 66/80/100 literals); fill top-edge color matches the band it overlaps at every height; transitions align in both orientations; top zone = the defined clip/err threshold; a signal at each threshold matches fill color to band edge.

### F22 · [MEDIUM] Blue accent is overloaded across five unrelated meanings
*Color usage & meaning · `App.css:931`*
- **Observation.** `--color-accent` simultaneously means focus ring, generic `.tbtn` hover, `.tbtn.active`, Solo-on, and clip selection — so a soloed button looks identical to a hovered/focused one, and an active toggle is nearly indistinguishable from a hovered one.
- **Why it matters.** One signifier → five signifieds forces recall (Nielsen #4, #6). Solo is a high-stakes toggle that must be instantly scannable; sharing its hue with ambient interactive color means it doesn't "pop" like arm (red) and mute (amber).
- **How others do it.** Pro Tools (red/yellow/orange, one hue per state), Reaper, Ableton, Logic — each state color used only for that state; hover/focus/selection kept in a separate band. Waver already uses red/amber, so Solo should take green.
- **Amendment.** Add `--color-solo` (green-500 `#3fb950`), point `.ts-btn.solo.on` at it in both themes; keep focus/selection on blue but make `.tbtn.active` visibly heavier than `:hover` (stronger fill/weight/inset ring).
- **Definition of Done.** `.ts-btn.solo.on` color ≠ accent/focus-ring/wave-sel/wave-clip-edge-sel in both themes; armed/muted/soloed render three distinct hues; active vs hover differ by more than the 14% tint; no CSS maps Solo-on to accent; new solo foreground/border ≥3:1.

### F23 · [MEDIUM] Control heights and corner radii are ad-hoc and don't share a rhythm
*Control sizing & density · `App.css:410`*
- **Observation.** Sibling controls use unrelated sizes: `.tbtn` 30px vs `.rec-btn` ~28px (padding-only) vs `.transport` 38px with one-off `border-radius:10px`; `.ts-btn` 26×22; `.track-remove` 18×18; `.pool-toggle` 26×26; radii scattered across 2/3/4/10px bypassing the radius tokens.
- **Why it matters.** Same-class controls should look like one system (Nielsen consistency); `.rec-btn`'s implicit height aligns only by coincidence (a latent regression), and buzzing radii undermine the crafted feel of a pro-audio tool.
- **How others do it.** Ableton/Logic build chrome on one control-height grid and a small radius set; Reaper exposes a global button height. This is Material dp size classes / Radix-shadcn size tokens — the `--radius-sm/md/lg` scale Waver already defines but bypasses.
- **Amendment.** Add `--control-h-sm/md/lg` tokens; pin `.rec-btn` to `--control-h-md`; `.transport` radius → `--radius-lg`; snap `.pool-toggle`/`.ts-btn` to a shared icon-button size; make `.track-remove` an explicit xs token; round meter-track radii to a token.
- **Definition of Done.** Control-height scale defined and referenced (no literal px heights/radius on the listed classes); `.rec-btn` and adjacent `.tbtn` have equal computed height; `.transport` radius on the {4,7,11} scale; every control height maps to a named token; no half-pixel misalignment in either theme.

### F24 · [MEDIUM] Time ruler has no fill/separator/ticks and mixes two coordinate systems with the beat grid
*Canvas / ruler & grid · `WaveformTimeline.tsx:332`*
- **Observation.** The 22px ruler band is the same surface color as the lanes — no background, no bottom divider, no ticks; labels float at y=14. Worse, the seconds label draw runs unconditionally, so with the beat grid on it paints seconds text over the bars-and-beats grid — two incompatible time metaphors layered.
- **Why it matters.** The ruler reads unfinished and fails to bound the time scale from the lanes (Gestalt common region); seconds-over-beats is a direct Nielsen #4/#2 violation, actively misleading for the beat-gridded workflow it should support.
- **How others do it.** Ableton/Pro Tools/Reaper enforce one timebase per ruler strip (stacked rows if both are wanted) and render the ruler as a distinct band with a hard divider and graduated ticks.
- **Amendment.** Add `--wave-ruler-bg` + `rulerBg`, fill the band and draw a 1px bottom divider; add major/minor ticks at labeled positions; make the label formatter follow the active grid (bar numbers when `beatGrid`, seconds otherwise) so only one metaphor shows.
- **Definition of Done.** Grid off: distinct fill, divider, ticks, seconds labels (both themes); grid on: bar/beat labels aligned to bar lines, no seconds text; labels/ticks stay aligned while scrolling with no horizontal body scroll; `+0.5` snapping keeps lines crisp at DPR 1 and 2.

### F25 · [MEDIUM] Record — the app's key action — is styled as an ordinary outline pill with no primary emphasis
*Top bar / hierarchy · `App.css:406`*
- **Observation.** `.rec-btn.start` has the same neutral border/background as New/Open/Save and only reveals red on hover; the 11px dot is the only resting cue. It becomes prominent only after recording starts.
- **Why it matters.** In a recording app Record is the primary CTA (Von Restorff isolation; Nielsen recognition-over-recall); at rest it has zero priority over routine file buttons, so a user hunts for it and it earns emphasis exactly when it matters least.
- **How others do it.** GarageBand/Logic/Audacity/Pro Tools/Reaper give Record a persistent red identity at rest. Material primary-action pattern: one high-emphasis filled button for the key action.
- **Amendment.** Give resting `.start` a red border + red text + subtle red-tinted background (reusing `--err` and the existing `color-mix` idiom), with hover as a stronger step; keep `.stop` distinct.
- **Definition of Done.** Record renders red at rest without hover; distinguishable from adjacent `.tbtn`; hover deepens the fill; `.stop` remains distinct; disabled still dims with no red emphasis; both themes legible.

### F26 · [MEDIUM] Spacing bypasses the token scale with pervasive 5/6/7/8px one-offs
*Spacing rhythm & alignment · `App.css:849`*
- **Observation.** tokens.css defines a 4/8/12/16px scale, but gaps/paddings use off-scale values (tbtn gap 6px + pad 0 10px, transport gap 6px, filebar 8px, track-head-main 7px, toggles 5px, plus 0.3/0.4/0.45rem paddings) — no consistent rhythm.
- **Why it matters.** 1–2px deltas break Gestalt proximity/common-region and Nielsen consistency; "almost aligned" reads as hand-nudged and amateur — the worst zone (below intent, above visible misalignment).
- **How others do it.** Ableton (one grid unit "U"), Pro Tools/Logic (fixed baseline module), Material 8dp / Apple 4-8pt grids: all spacing as multiples of a base unit via tokens, no raw literals.
- **Amendment.** Snap every gap/padding/margin to `--space-*` (add a 6px step if needed); add a Stylelint `declaration-strict-value` rule on spacing properties.
- **Definition of Done.** No hardcoded px/rem spacing on gap/padding/margin/inset in App.css; the scale is defined once and referenced; Stylelint fails CI on raw spacing lengths; transport/filebar/track-head render without clipping and with visually equal per-group gaps.

### F27 · [MEDIUM] Icon set mixes stroke weights 1.4–2.6 and the record button ignores the icon system
*Iconography · `icons.tsx:110`*
- **Observation.** IconPause overrides to 2.6, IconChannels to 1.6, IconGrid to 1.4 (vs the intended weight 2), so grid/channels look faded next to plus/undo/split. A dedicated `IconRecord` exists but the record button uses a CSS `<span class=rec-dot>` instead. Play/Stop are filled but Pause is two thin strokes, so the button's mass jumps on toggle.
- **Why it matters.** A toolbar reads as a family only at one weight (Nielsen consistency, Gestalt similarity); a ~1.9× ink difference implies a false disabled state; the safety-critical record control is the one control off the audited icon system; the play↔pause mass jump reads as a layout shift.
- **How others do it.** Ableton/Logic ship one-weight icon families with record as a real filled-circle member and constant transport mass. Material Symbols (one weight axis) / SF Symbols: uniform weight; per-icon weight is an anti-pattern.
- **Amendment.** Remove the three strokeWidth overrides (inherit 2; trim IconGrid geometry if too dense); render `IconRecord`/`IconStop` in AudioControls, move the pulse to the button/icon, delete `rec-dot`/`rec-square`; make IconPause filled rects for constant mass.
- **Definition of Done.** No icon sets a non-default strokeWidth; `IconRecord` used outside icons.tsx and no `rec-dot`/`rec-square` remain; the record button renders an `<svg>`, red in both states, with a visible recording pulse; grid/channels match neighbor weight; play→pause→stop shows no mass change; build/typecheck clean.

### F28 · [MEDIUM] Armed-track tint at 9% red is effectively invisible
*Track headers / states · `App.css:857`*
- **Observation.** `.track-head.armed` uses `color-mix(--err 9%, transparent)` — barely perceptible in dark mode, weaker over white in light mode — so the "this track records next" signal rests almost entirely on the 18px R button.
- **Why it matters.** Arm is consequential and easy to forget (wrong-track arming blows a take — FR-2.3). A 9% wash fails Nielsen #1 and recognition-over-recall, and at ~1.1–1.2:1 fails WCAG 1.4.11 (needs ≥3:1).
- **How others do it.** Pro Tools blinks bright red; Ableton tints the whole armed title/slot red; Logic blinks the R + highlights the header; Reaper tints the arm area. Common: a peripherally-visible track-level treatment, redundant coding, and an armed-vs-recording distinction.
- **Amendment.** Raise the wash to ~16%, add an inset red left bar, and turn the identity strip red; recommend a distinct `.recording` pulse state; verify both `[data-theme]` blocks clear 3:1.
- **Definition of Done.** Armed treatment ≥3:1 vs unarmed background in both themes; a redundant non-color cue present; armed vs unarmed distinguishable at a glance; armed-idle distinct from recording (if added); dimmed/solo/mute states remain distinct.

### F39 · [LOW] Two unequal left-gutter widths (200px pool vs 190px track headers) stack side by side
*Layout / alignment · `App.css:609`*
- **Observation.** `.media-pool` is 200px and the adjacent `.track-headers` gutter is 190px — two near-identical panels with the same fill/divider read as a 10px misalignment.
- **Why it matters.** The 10px delta is the uncanny zone (Nielsen consistency, aesthetic/minimalist): too small to be hierarchy, too large to be identical, signalling no grid; there's also no single source of truth for the gutter width.
- **How others do it.** Reaper (one theme-defined TCP width), Ableton (deliberately distinct column widths). 8-point grid: 200px is on-grid, 190px is off-grid — snap both to a shared token.
- **Amendment.** Add `--workspace-gutter: 200px` and drive both panels from it (remove the literal 190px). If a difference is wanted, make it unambiguous (e.g. 240 vs 200).
- **Definition of Done.** Both computed widths equal (200px); a single source of truth (no 190px/second literal); two equal 200px columns at 100% zoom; canvas still fills remaining width; collapse override still works.

### F40 · [LOW] Disabled and hover states are inconsistent across control families
*States (hover/disabled) · `App.css:915`*
- **Observation.** Disabled opacity varies (tbtn 0.4, transport 0.4, rec-btn 0.45, devsel select 0.5) — four values for one meaning; the colored on-states of R/M/S get no hover feedback and there's no `:active` anywhere, so engaged toggles feel dead vs the `.tbtn` family.
- **Why it matters.** Same-meaning affordances drawn at three brightnesses break Nielsen #4; toggles that don't acknowledge the pointer break #1 and, on the R/M/S critical path, invite mis-arms (FR-2.3).
- **How others do it.** Ableton (global state opacity tokens; Arm/Mute/Solo brighten on hover, distinct pressed shade), Pro Tools (lit toggles still lighten/darken). Material state-layer system: one disabled opacity + fixed hover/pressed overlays on any control.
- **Amendment.** Define `--state-disabled-opacity`/`--state-hover-lift`/`--state-active-lift`; replace the four literals; add `.ts-btn:active` press feel and per-color on-state hover/active rules reusing the transport pattern.
- **Definition of Done.** Every `:disabled` rule resolves to one token (no 0.4/0.45/0.5 literals); hovering an engaged R/M/S changes its background; pressing any transport/rec/track toggle shows an `:active` change; disabled controls render at identical opacity; verified both themes with no `.on` regression.

### F41 · [LOW] Multichannel waveform labels use a hardcoded 9px font at the clip's trim/fade edge
*Canvas / waveform · `renderer.tsx:258`*
- **Observation.** Per-channel L/R labels use literal `9px system-ui` at `x0+3` — below the smallest token and sitting in the left trim/fade hit zone, so on short/trimmed stereo clips the label collides with the fade handle and trim region and is barely legible.
- **Why it matters.** Sub-token 9px on a HiDPI webview fails legibility (Nielsen aesthetic/minimalist) and the label overlaps the direct-manipulation handles it shares pixels with (recognition-over-recall + interaction conflict), worst on narrow clips.
- **How others do it.** Audacity/Pro Tools/Ableton/Logic put channel identity in the header gutter and reserve clip-edge pixels for fade/trim handles; keep on-canvas type at/above the design minimum.
- **Amendment.** Pull label font from a token/constant ≥11px; offset the label past `FADE_ZONE_PX` (or right-align) so it clears both handle zones; skip the label when the clip is too narrow; nudge it to the channel mid.
- **Definition of Done.** No literal `9px`; label ≥11px; label x-range doesn't intersect the trim-start/fade-in zones; narrow stereo clips draw no channel label; left-edge handles unobstructed at Retina scale; mono clips unchanged.

---

## 6. Information architecture & content

> **Leading with the user's explicit asks:** track **rename** (F8, and its UX twin F21 in §4), track **color** (F9), and track **detail display** — sample rate, mono/stereo, duration (F10) and amplitude/level range (F33). These are followed by the remaining confirmed infoarch findings. The through-line: **the model already carries this information; the view boundary or the render layer throws it away.**

### F8 · [HIGH] Track name is display-only — there is no rename affordance anywhere *(user ask: rename)*
*Track headers · `TrackHeaders.tsx:53`*
- **Observation.** The name is a static `<span>` — no click-to-edit, no double-click, no input, no `api.setTrackName`. The model fully supports it (`Track.name` is a mutable String round-tripped as `TrackView.name`); names can only ever be the auto-generated "Track N"/"Take N"/channel-split strings, so two "Track 2" recordings are indistinguishable.
- **Why it matters.** The name is the primary content identifier in a multitrack recorder (Nielsen #7, #2, and #4 — every neighboring affordance is editable, so a read-only name reads as a missing feature). Directly defeats the user's stated need to tell recordings apart.
- **How others do it.** Reaper (double-click / F2 / Enter inline), Pro Tools (nameplate dialog), Ableton (Cmd/Ctrl+R inline, Tab to next), Audacity (Track Menu > Name…). Universal: the label *is* the edit affordance — commit on Enter/blur, cancel on Esc.
- **Amendment.** Add `set_track_name` to `waver-core` through the undoable `apply_edit` path → a registered Tauri command → `setTrackName` in the API/`useProject` → click-to-edit control in TrackHeaders (double-click / Enter-F2, seeded+select-all input, commit on Enter/blur, reject empty, cancel Esc, guard against transport-key bubbling, `aria-label="Rename track"`).
- **Definition of Done.** Double-click (or Enter/F2) shows a seeded, selected input; Enter/blur persists (header + `TrackView.name` + dirty); Escape discards; empty/whitespace reverts; rename is undoable/redoable via `apply_edit`; transport keys don't fire while editing; rename survives save/reload; keyboard-reachable and announced to AT; a `waver-core` unit test asserts the name change + undo entry.
- **Shared with F21 (UX).** Same deliverable; ship once at HIGH.

### F9 · [HIGH] Track color is positional-index derived, not editable and not persisted *(user ask: color)*
*Track headers · `renderer.ts:19`*
- **Observation.** Color comes purely from array index via `trackColor(index)` cycling an 8-entry palette, applied to the header strip and the clip tint. There is **no color field on `Track`** and no picker. So deleting/reordering reassigns every downstream color, the 9th track repeats color 1, and nothing survives save/load.
- **Why it matters.** Color is how users build a durable mental map ("the blue track is drums"); deriving it from position breaks recognition on every reorder/delete (Nielsen consistency, recognition-over-recall) and gives no way to fix a color (user control). Past 8 tracks, collisions make unrelated tracks indistinguishable.
- **How others do it.** Reaper (persistent per-track `PEAKCOL` + swatch), Ableton (per-track/clip color in the .als, palette only a default), Logic/Pro Tools (persistent picker). Best practice: bind identity to a stable object id and serialize it — never re-derive from ordinal position.
- **Amendment.** Add `pub color: Option<String>` to `Track` (`#[serde(default)]`, `None` default) → `set_track_color(track_id, color)` command → `trackColor(track.color, index)` returning `track.color ?? palette[index%8]`, keyed on the track at both call sites → a clickable `.track-color-strip` swatch popover (8 presets + `<input type=color>`). `None` renders the index fallback for migration.
- **Definition of Done.** `Track` has a serialized `color`; a custom color round-trips through save/reload and app restart; reordering/deleting a track changes no other track's color; the 9th+ track is editable and distinct; strip and clip tint update together; pre-existing files without `color` load via serde default; a unit test asserts stored-color vs palette-fallback.

### F10 · [HIGH] Track header hides source details the model already knows (sample rate, channels/stereo-mono, duration, clip count) *(user ask: track details)*
*Track headers · `TrackHeaders.tsx:51`*
- **Observation.** The header renders only name, R/M/S, and gain. Nothing shows sample rate, channel count (stereo/mono), duration, or clip count — even though `Source` carries `channels/sample_rate/frames` exposed on `SourceView`, and clip count is already computed (only to build the delete-confirm string).
- **Why it matters.** Format (mono/stereo, sample rate) and length are first-class facts an editor needs to reason about mixing, resampling, and phase/pan (Nielsen visibility, recognition-over-recall). A source↔project sample-rate mismatch is exactly the silent, quality-degrading condition a header badge should surface before an artifact is heard (FR-2.3). This is the user's explicit "tracks should show details" request.
- **How others do it.** Audacity prints "44100Hz / 32-bit float" + mono/stereo in the header gutter; Pro Tools/Logic show a mono-vs-stereo glyph and flag rate mismatches on import; Ableton warns on rate mismatch. The heuristic: the track container owns and displays its source metadata — completing the "track owns its controls" pattern the code's own comment cites.
- **Amendment.** Build a `sourceById` map; per track derive clip count, the distinct referenced sources, and channels/sample_rate — show "Stereo · 44.1 kHz" when uniform, "Mixed" when they differ, a warning badge when any source rate ≠ project rate; derive duration as the max clip end formatted mm:ss.mmm; render a read-only `.track-head-meta` line between the name row and toggles; guard the empty-track case.
- **Definition of Done.** A single-source stereo 44.1 kHz track shows Stereo / 44.1 kHz / duration / clip count without opening a clip; mono shows "Mono", >2ch shows "N ch"; mixed sources show "Mixed"; a source-vs-project rate mismatch shows a badge (none when matching); an empty track renders safely ("Empty"/blank); the line stays within `TRACK_HEIGHT` and preserves 1:1 lane alignment; values update reactively; delete-confirm behavior unchanged.

### F33 · [MEDIUM] No amplitude/peak level readout for sources or clips although the peak cache holds the data *(user ask: amplitude/level range)*
*Media pool / Inspector · `renderer.ts:200`*
- **Observation.** `waveDisplayGain` already scans the peak pyramid and computes a source's loudest sample, and the per-source min/max data exists — but the value is used only to auto-scale drawing and is never surfaced anywhere as a number (pool, inspector, or header).
- **Why it matters.** The user explicitly named "amplitude/level range" as a track detail. Without a numeric peak/dBFS a user can't tell a clipped take (0 dBFS) from a buried one (−40 dBFS), and the auto-scaled waveform *actively hides* true loudness (a −30 dB and a −3 dB take look equally tall) — Nielsen visibility, and it breaks the gain-staging feedback loop editors depend on. The honest number sits one line away from being displayed.
- **How others do it.** Audacity (Amplify pre-fills detected peak dB), Reaper (Item Properties / Normalize show peak dBFS + clip indicators), Pro Tools/Audition (Amplitude Statistics: peak + RMS per clip). Best practice: min/max data used for drawing is also shown as a dBFS number.
- **Amendment.** Add `sourcePeakDbfs(pyramid)` (from the finest level, cached in a WeakMap) returning `20*log10(peak)`; surface it in the pool row meta ("silent" for −∞, red for ≥ −0.1 dBFS) and as a read-only "Source peak" row in the Inspector.
- **Definition of Done.** A unit-tested helper maps peak → dBFS (1.0→0.0, 0.5→≈−6.02, all-zero→silent/−∞); every pool row shows a dBFS peak; the Inspector shows the selected clip/source peak; a source ≥ −0.1 dBFS is flagged clipped; the readout appears once peaks load and is cached (no re-fetch per render); `waveDisplayGain` still returns the same auto-scale gain.

### F11 · [HIGH] Clip.name exists in the model but is dropped from ClipView, so clips are unlabeled rectangles
*Clip editing · `project.ts:5`*
- **Observation.** `Clip` carries a display name (defaulting to the source stem), but the `ClipView` interface omits `name` and the canvas never renders any clip label. Users can't tell which source a clip came from, or distinguish split halves, by looking at the timeline. The data exists end-to-end in Rust but is stripped at the view boundary.
- **Why it matters.** On-screen object identity should be legible without recall or per-clip clicking (Nielsen visibility, recognition-over-recall) — most acutely for the two identical halves a split produces. Any session with more than a couple of files forces trial-and-error selection.
- **How others do it.** Ableton (editable top-left clip label), Pro Tools (clip-header name + auto-suffixed split names), Reaper (item name + "Show labels"). Best practice: a truncated, ellipsized name pinned top-left, contrast-safe, hidden when too narrow.
- **Amendment.** Add `name: string` to `ClipView` (payload already carries it) and a label pass in `draw()` — `ctx.clip()` to the clip rect, a themed `clipLabel` color, ghost-alpha aware, drawn only when the clip is wide enough (~>24px). (Optional follow-up: double-click rename à la Cmd+R.)
- **Definition of Done.** `ClipView` declares `name` and typechecks; dropping "guitar.wav" shows "guitar" top-left; splitting yields two labeled halves; clips below the width threshold show no label; long names clip to the rect; the label respects ghost opacity and is legible for selected/unselected clips in both themes.

### F12 · [HIGH] Time is shown only in seconds — no bars:beats readout even when the beat grid is enabled
*Transport / ruler · `renderer.ts:86`*
- **Observation.** `fmtTime` only produces "m:ss"/"Ns" and is the sole ruler formatter; the transport readout prints raw seconds. Enabling the beat grid draws bar/beat/step lines at a real BPM, yet the ruler and readout stay in seconds — the grid is visual-only and the number never reflects it.
- **Why it matters.** A musician sets a tempo to work in musical time, but every number stays in seconds (Nielsen match-to-real-world, recognition-over-recall — placing an edit at "bar 5 beat 3" requires mental bars→seconds conversion against labels that don't line up with the bar lines). The user called this out directly.
- **How others do it.** Ableton (Bars.Beats.Sixteenths primary, toggle to seconds), Reaper (Measures.Beats, combined mode, measure|beat transport), Logic (stacked Bars/Beats + Time). Best practice: when a tempo/grid is active, the primary readout and ruler labels are musical, seconds secondary.
- **Amendment.** Add `fmtBarsBeats(t, bpm, gridDiv)`; in the ruler loop, when `beatGrid` is on iterate bar/beat positions and label strong lines with the bar number; render the musical position in the transport readout (seconds optional/secondary); keep seconds when the grid is off.
- **Definition of Done.** Grid off: seconds unchanged; grid on at 120 BPM/gridDiv 4: readout shows bars:beats:ticks and 9.0s reads "5.3.1"; ruler labels sit on bar lines as bar numbers aligned to the strong grid lines; BPM/gridDiv changes update grid + labels together; a unit test asserts `fmtBarsBeats(9.0,120,4)==="5.3.1"` and `(0,120,4)==="1.1.1"`.

### F29 · [MEDIUM] Inspector is an editor only — it shows no clip identity, source, length, position, or channel
*Inspector · `Inspector.tsx:29`*
- **Observation.** The Inspector renders only editable controls (clip gain, fades, parent-track gain). It never shows the clip's name, source file, length, timeline start, or whether it's a split-out mono channel (`source_channel`) — all available on the `ClipView`/`SourceView` in scope. It answers "what can I change" but not "what am I looking at".
- **Why it matters.** The one surface dedicated to a selected clip forces recall of identity/extent (Nielsen visibility, recognition-over-recall); with duplicated sources or L/R splits, the user can't confirm the target before editing — and omitting `source_channel` hides split-mono identity in the exact place built to describe it (FR-2.3 / channel-split are load-bearing).
- **How others do it.** Pro Tools (clip name + source + start/end/length), Reaper (F2 shows source path, length, position, channel mode), Ableton (clip name + length), Audacity (name + selection start/length). Best practice: read-only identity + extent above the editable parameters.
- **Amendment.** Add a read-only identity header above Clip gain: basename from `source.path`, a channel tag when `source_channel` is non-null (L/R/ch N), length = `(source_out−source_in)/sr`, position = `timeline_start/sr` — all already on the current payload.
- **Definition of Done.** A selected clip shows source basename, length, and start above the editable controls; non-null `source_channel` shows L/R/ch N (none when null); length/position equal the frame math; two clips from the same source but different channel/position are distinguishable; identity fields are read-only; empty state unchanged; RTL-testable.

### F30 · [MEDIUM] Meter's numeric dBFS + channel number are suppressed in the only mode the app renders
*Metering · `Meter.tsx:80`*
- **Observation.** The numeric peak dBFS + channel index render only when `!compact`, but the meter is mounted exclusively `compact` in the top bar. So users see bars with no number, no channel label, and no scale marks over the −60..0 dBFS range; clip-latch and peak-hold values are computed but never shown as text.
- **Why it matters.** A recorder's meter must answer "how hot, in dB?" and "am I clipping?" before a take (Nielsen visibility, recognition-over-recall) — critical for release-blocking clean capture. The irony: the code already computes and formats everything, then gates it out of the only rendered mode.
- **How others do it.** Reaper (numeric peak + latched value + dB scale toggle), Ableton (latched numeric peak, click-to-reset), Pro Tools (peak-hold value + labeled dB scale). Standard (IEC/EBU, K-System): scale + moving bar + latched numeric peak + clip flag, all visible.
- **Amendment.** Render the readout in compact mode (CSS-shrunk, tabular-nums) showing `fmtDb(peak-hold ?? peak)` + channel index; add a compact clip readout on latch; add a few labeled dB ticks (0/−12/−60) via the existing normalize helpers; add a per-channel `aria-label` with the dB.
- **Definition of Done.** Each compact channel shows a numeric peak dBFS + channel number during live input; the number equals `fmtDb` of the latched peak and updates (−12.3→"-12.3", silence→"-∞"); a dB scale with ≥ 0/−12/−60 is visible and the −0.1 dB condition shows a latched clip; click still resets hold+clip and the number; each channel exposes the level to AT; no non-compact regression; no Rust change.

### F31 · [MEDIUM] Project sample rate / format is never displayed; capture rate is a separate, possibly divergent value
*Top bar / project status · `FileBar.tsx:44`*
- **Observation.** `project.sample_rate` drives export and all frame↔second math but is shown nowhere. The only sample-rate widget is the device *capture* rate in the settings popover — a different value that can diverge from the project's rate, with no way to reconcile them.
- **Why it matters.** Sample rate is the most fundamental project attribute (governs pitch, duration, export fidelity) yet is invisible (Nielsen #1); a capture-vs-project divergence causes silent resampling / wrong-speed playback undetectable until the export sounds wrong (#5, #9) — exactly what a clean-capture tool must not allow blind.
- **How others do it.** Pro Tools (Sample Rate + Bit Depth at the top of Session Setup; blocks mismatched import), Audacity (persistent Project Rate selector + per-clip rate + resample warning), Logic (control-bar LCD + mismatch warning). Best practice: the project's own format is a first-class, always-visible readout.
- **Amendment.** Render a compact read-only `filebar-format` ("48.0 kHz") beside the file name; thread the live capture rate into FileBar and, when it differs, add a warning modifier + tooltip naming both values; optionally show source rate in MediaPool; keep bit-depth/format as export-time choices (relabel "Export format").
- **Definition of Done.** The top bar shows the project rate from `project.sample_rate` on empty and populated projects; it updates when a different-rate project opens; a capture-vs-project mismatch shows a color+tooltip indicator (none when matching); the shown value equals the exported value; a UI test asserts a "kHz" element bound to `project.sample_rate`; no export/timing regression.

### F32 · [MEDIUM] No unsaved-changes / dirty indicator — save state must be inferred
*Top bar / project status · `FileBar.tsx:145`*
- **Observation.** The file bar shows a remembered path basename and transient messages, but no modified marker (no asterisk, no unsaved state) despite edits flowing through undoable history. After any edit the user can't tell whether the on-disk file is current, and New discards the project with at most a native confirm.
- **Why it matters.** Nielsen #1 and #5 plus the macOS document-modified convention: dozens of undoable edits between saves with no dirty marker mean over-saving or lost work, and New's silent discard is the "guess your state, then lose it" hazard the release-blocking capture work can't tolerate. *(This is the read-only status/content counterpart to F1's guard work.)*
- **How others do it.** Reaper/Pro Tools/Audacity (title asterisk + Save/No/Cancel on New/Open/close), Logic/GarageBand (macOS modified dot + "Edited"). Pattern: a persistent dirty glyph tied to a saved-vs-current revision + a mandatory Save/Discard/Cancel gate before state-destroying actions.
- **Amendment.** Track a monotonic edit revision in Rust, expose `revision` + undo depth on `ProjectView`; keep `savedRevision` in FileBar (set after Save/Save As/Open/New), compute `dirty = revision !== savedRevision`; render a bullet/asterisk in the file label + OS window title; gate New/Open (and `onCloseRequested`) behind Save/Discard/Cancel. Revision-equality makes undo-back-to-saved clear the marker for free.
- **Definition of Done.** Any undoable edit shows a marker in the file bar + window title within one render; Save/Save As clear it (reappears on next edit); undo back to the saved revision clears it, redo re-sets it; New/Open while dirty show Save/Discard/Cancel (Cancel intact, Discard proceeds, Save persists then proceeds); close while dirty is intercepted; a fresh unedited project shows no marker and no prompt.

### F42 · [LOW] Media-pool item metadata is minimal and mislabeled for humans
*Media pool · `MediaPool.tsx:104`*
- **Observation.** A pool row shows only "{dur}s · {channels}ch": channels as a raw count ("2ch") not stereo/mono, no sample rate (available on `SourceView`), and bare seconds ("183.0s" for 3:03). The full path is only a hover title.
- **Why it matters.** The bin is each asset's primary at-a-glance identity: "183.0s" forces arithmetic (Nielsen match-to-real-world), "2ch" is ambiguous jargon, and hiding sample rate hides resample risk against the project rate (FR-2.3). Recognition-over-recall is undercut.
- **How others do it.** Pro Tools (Format=Stereo/Mono + Sample Rate + Bit Depth columns, timecode length), Ableton (Stereo/Mono + rate + mismatch warning), Logic (mm:ss + format + rate), Reaper (Length/Channels-as-format/Sample Rate + resample indicator). Convention: formatted duration + human channel format + sample rate, humanized units.
- **Amendment.** Add `fmtDur` (mm:ss ≥60s else decimal s), `fmtChannels` (Mono/Stereo/N ch), `fmtRate` ("48 kHz"/"44.1 kHz"); render all three; optionally flag rate mismatch vs `project.sample_rate`; keep the path tooltip.
- **Definition of Done.** 183s→"3:03", 12.4s→"12.4s"; 1/2/6ch→"Mono"/"Stereo"/"6 ch"; sample rate humanized from `source.sample_rate`; path stays on hover; (if implemented) a 44.1 kHz file in a 48 kHz project shows a warning (none when matching); unit tests cover the formatter boundaries and a component test asserts the meta line.

### F43 · [LOW] Track gain is shown at inconsistent precision between the two places that edit it
*Track headers / Inspector · `TrackHeaders.tsx:109`*
- **Observation.** The same `Track.gain_db` renders as whole dB in the header (`toFixed(0)`) but one decimal in the Inspector (`toFixed(1)`) and the header slider tooltip (`toFixed(1)`). With a 0.5 dB step, −3.5 dB reads "−4 dB" in the header and "−3.5 dB" in the Inspector — the same control disagreeing with itself.
- **Why it matters.** Every odd half-step is mis-rounded in the header, so the number you set isn't the number shown back (Nielsen visibility, consistency); the mismatch reads as a bug and erodes trust in a tool where dB is load-bearing.
- **How others do it.** Ableton/Pro Tools/Reaper show gain in tenths of a dB, identically everywhere the value appears. Best practice: one formatting function per unit, display precision ≥ control step, applied to every rendering.
- **Amendment.** Add a shared `formatGainDb(db) => `${db.toFixed(1)} dB`` and use it in the header readout + tooltip and the Inspector; widen `.track-gain-val` if needed rather than reducing precision.
- **Definition of Done.** One formatter is the only gain-to-string path (no `gain_db.toFixed(0)` / raw `.toFixed(` on gain); −3.5 dB shows "-3.5 dB" in all three surfaces; spot-checks (−24/−3.5/0/6.5/12) match everywhere; the value cell shows one decimal without overflow; setTrackGain wiring unchanged.

### F44 · [LOW] No total project/timeline duration or clip-length readout anywhere
*Transport / status · `WaveformTimeline.tsx:1182`*
- **Observation.** The status line shows only zoom + playhead ("{pps} px/s · {playheadSec}s"). No total timeline length, per-clip duration, or selection length — all trivially derivable from `clip.timeline_end()`/`len()`, already mirrored as `source_out−source_in`.
- **Why it matters.** In a time-based tool users can't answer "how long is my project / this take / this selection?" without eyeballing a zoom-dependent ruler (Nielsen visibility) — load-bearing for confirming capture length numerically (FR-2.3).
- **How others do it.** Reaper (transport time + selection Length field), Ableton (song position + clip length box), Pro Tools (Start/End/Length counters), Audacity (Selection Toolbar Start + End/Length). Best practice: a live, zoom-independent Start/End/Length triad + total-project-length readout.
- **Amendment.** Extend `.wave-info`: total length = max of `(timeline_start+clipLen)/sr`; selected-clip duration = `clipLen(c)/sr` when a clip is selected; reuse `clipLen`/`sr`; a small `fmtDur` (mm:ss.SS ≥60s); title tooltips for discoverability.
- **Definition of Done.** With clips, the status shows a total length equal to the last clip's right edge; empty project shows 0.00s (no NaN); selecting a clip shows its duration and deselect hides it; values are zoom-independent; correct after trim/split/move/delete and undo/redo; verified against the ruler in the running app.

---

## 7. Prioritized roadmap

Grouped by priority. Rationale: **P0** = silent/unrecoverable loss on the release-blocking capture path, plus the user's explicitly requested track-identity/detail features. **P1** = remaining HIGH severity (theme/contrast/legibility parity and missing musical/label information). **P2** = MEDIUM/LOW polish, accessibility hardening, and content consistency.

### P0 — Stop data loss, then deliver the explicit user asks
*Release-blocking safety and the three named requests.*
- **F1** — Dirty flag + save-or-discard guard on New/Open (unsaved-changes protection). Pairs with **F32** (the visible dirty indicator + close-request gate) — ship the revision/dirty plumbing once and use it for both.
- **F2** — Lock device/sample-rate/buffer during recording + fail-safe teardown that finalizes the take.
- **F8 / F21** — Track rename (inline click-to-edit, undoable) — *user ask.* Single deliverable.
- **F9** — Persistent, editable per-track color (model field + picker + migration) — *user ask.*
- **F10** — Track-header source details: sample rate, mono/stereo, duration, clip count, mismatch badge — *user ask.*
- **F33** — Amplitude/peak dBFS readout for sources/clips (pool + inspector) — *user ask (level range).*

### P1 — Remaining HIGH: theme parity, legibility, and missing structural information
- **F3** — Token-drive fade colors (kill hardcoded dark-theme constants; WCAG 1.4.11).
- **F4** — Contrast-aware clip fills (replace fixed 22% alpha; light/dark parity).
- **F5** — Real type scale / body tier (fix flat two-size hierarchy and sub-legible muted copy).
- **F6** — Style the native gain/fade sliders (themed, track-colored, one control size class).
- **F7** — Unify meter zone thresholds (scale vs fill agreement; clip at 0 dBFS).
- **F11** — Restore `ClipView.name` and render clip labels (identify clips, split halves).
- **F12** — Bars:beats readout + bar-number ruler labels when the beat grid is on.

### P2 — MEDIUM/LOW: interaction correctness, accessibility, and content polish
**Transport & editing correctness:** F13 (disabled-reason tooltips), F16 (Space double-fire), F17 (deterministic Stop + return-to-start), F18 (select ≠ seek), F35 (consistent destructive-confirm), F36 (Record/Stop shortcuts), F37 (reset-to-0dB + numeric gain entry), F34 (disable empty Paste), F19 (surface the hidden fade-curve gesture).

**Navigation & accessibility:** F15 (keyboard access to clips; fix `role="application"`), F20 (scrollbar + fit + Home/End), F38 (persist theme + workspace state).

**Media pool & inspector content:** F14 (remove sources / remove-unused), F29 (inspector identity header), F30 (numeric meter readout in the shipped mode), F31 (project sample-rate readout + mismatch), F42 (humanized pool metadata), F43 (single gain formatter), F44 (total/selection duration readout).

**Visual system polish:** F22 (give Solo its own hue; disambiguate active vs hover), F23 (control-height + radius rhythm), F24 (ruler fill/divider/ticks + single timebase), F25 (Record as resting primary CTA), F26 (spacing token rhythm), F27 (uniform icon weight + on-system Record icon), F28 (stronger armed-track cue ≥3:1), F39 (unify the two left-gutter widths), F40 (consistent disabled/hover/active states), F41 (larger, non-colliding channel labels).

---

*Consolidation notes for planning: F1↔F32 share the dirty/revision plumbing; F8↔F21 are one rename deliverable; F3/F4/F5/F6/F7/F22/F28/F40 are all token/contrast work in `tokens.css` + `App.css` + `renderer.ts` and can land as a coordinated theming pass; F10/F29/F30/F31/F42/F43/F44 are all "surface data the model already has" and share the `SourceView`/`ClipView`/`ProjectView` read paths.*