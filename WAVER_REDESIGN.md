# Waver UX Redesign — 2026-07-07

Full-app UX audit + redesign, run as a multi-agent workflow: **6 auditors** (visual
hierarchy, design tokens, interaction flows, DAW conventions, accessibility,
micro-polish) read the entire UI codebase → **62 raw findings** → synthesis deduped,
verified against the code, and ranked them into **39 items** (`W-01`–`W-39`:
3 P0, 16 P1, 20 P2). **38 implemented** in commits `9f43b73` + `586c884`.

## The diagnosis (audit summary)

> Waver's bones are good — a real token system, canvas theming, a broad edit keymap —
> but six lenses converge on three systemic failures: the record workflow is split and
> unsafe; feedback is either layout-shifting or silent; and keyboard/AT support
> collapses at the overlay/popovers and in the track gutter.

## What changed

### P0 — systemic

| ID   | Change                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W-01 | **Unified transport**: Rec joined Play/Stop as a 38px transport button; **Space during a take stops capture** (never starts playback into the live mic — FR-2.3); `Shift+R` toggles record; Stop restyled neutral (red = record only). |
| W-02 | **Toast overlay** replaces in-flow banners: fixed top-right, canvas never reflows; every toast dismissible; notices auto-expire (6s); errors persist + action-prefixed ("Couldn't open the input device — …").                         |
| W-03 | **Modal a11y**: shortcuts overlay traps Tab + restores focus; keymap dead behind the modal; hierarchical Escape (popover → overlay → stop playback → deselect); device/color popovers close on Esc.                                    |

### P1 — flows, layout, a11y

- **W-04/05** `⌘S`/`⇧⌘S`; save/export failures → error toasts, successes → transient
  aria-live status that yields to the dirty dot; "Saving…/Exporting…" busy labels.
- **W-06/08** Live recording overlay anchors where the take will _commit_; the finished
  take (and every paste/duplicate/drop) is **selected + scrolled into view**, with a
  notice when placement was relocated; dead clipboard disables Paste and explains itself.
- **W-07** Record-arm is a true tri-state: disarming sticks; Rec tooltip explains the
  unarmed fallback.
- **W-09** Dropping onto an empty timeline creates the track _and places the clip_.
- **W-10/11** Focus ring follows the theme accent; track palette tokenized per theme
  (`--track-1..8`, light set ≥3:1 on light lanes); clip-label ink picked by luminance.
- **W-12** Input meter labeled with a mic icon; **armed-track mini meter** in the gutter
  (signal + clip in the capture line of sight). _Deferred:_ true master output meter —
  needs engine-side playback level streaming.
- **W-13** Big tabular-mono **timecode** beside the transport (red elapsed while
  recording); the muted "12.34s · px/s" readout is gone.
- **W-14–17** 24px gutter targets; hover/focus-revealed delete; no-reflow color strip
  (scaleX hover + invisible hit extension); pool rows focusable with **place-at-playhead**
  (button + Enter); keyboard track rename (Enter/F2); rec button aria-pressed + labels.
- **W-18/19** Toolbar reorganized into four fixed zones on a single 56px row
  (overflow-x scroll, no wrap-shatter); clip-edit cluster icon-only; BPM cluster
  width-stable (disabled, not unmounted); inspector fixed-height (no canvas re-layout
  on select/deselect).

### P2 — tokens & polish

Monotonic gray ramp + perceptible lane zebra (W-21); `--font-mono` for every time/dB
readout + tokenized canvas fonts + 12px floor for the workhorse text size (W-22);
elevation/radius tokens applied to all floating surfaces (W-23); 4px spacing grid
(W-24); `Home`/`End`/`+`/`−`, Esc-stops-playback, arrows only act with a selection
(W-25); M/S letter toggles (W-26); inspector **Start** (editable timecode) + **Length**

- typed dB (W-27); gesture-true cursors (W-28); dedicated zoom-to-selection glyph
  (W-29); reachable first-run hint overlay (W-30); theme toggle moved out of the file
  group + persisted + pre-paint init honoring the OS scheme (W-31/W-20); aligned 56px
  seams (W-32); focusable meter reset (W-33); named color swatches + selected state
  (W-34); shared `+`-signed dB formatter (W-35); 120ms control transitions + :active
  states (W-36); crisp clip borders (W-37); major/minor time ticks (W-38); themed
  scrollbars (W-39).

## Verification

- `tsc` + `vite build` green; 50 Rust tests pass.
- The cloud adversarial-review workflow hit the session spend limit (0 of 4 reviewers
  completed) — replaced with an inline self-review that found and fixed **4 real bugs**
  before release: inspector fixed-height clipped the new Start/Gain rows; the mini
  meter overflowed the fixed track header; `⌘S` bypassed the busy guard; toast
  auto-expiry reset on every App re-render (meter updates → notices never expired).
  A re-run of the adversarial workflow is recommended when the session limit resets.

## Open follow-ups

1. **Master output meter** (W-12.3) — engine work: stream playback levels like the
   input MeterUpdate channel; stereo master meter + clip latch next to the timecode.
2. Right-click context menus, timeline quick-play, zoom-adaptive beat grid (Tier-1
   QoL leftovers from `WAVER_QOL.md`).
3. Re-run the adversarial review workflow over `9f43b73`+`586c884`.
