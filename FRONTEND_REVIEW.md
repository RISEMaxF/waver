# Frontend architecture, theming & DAW-UX review — Waver

## 1. Executive summary

**Verdict: cleanly separated and well-layered — but not yet theming-ready.** The architecture is genuinely sound: presentation (`components/`), state (`useAudio`/`useProject`), IPC (`api.ts`/`project.ts`/`files.ts`/`peaks.ts`), and wire types are properly separated, and the canvas-for-waveform / DOM-for-everything-else split is the correct call. The two structural liabilities are `WaveformTimeline.tsx` (a 954-line god-component) and a silent error path where failed edits give the user no feedback.

On the central ask — _is it easy to change theme/style?_ — the answer today is **no**. There is a real but shallow token foundation (9 color CSS vars, used consistently, with smart `color-mix` derivations), but color is the _only_ tokenized dimension: spacing, radii, and type are ad-hoc literals; there is no semantic token layer, no `data-theme`/light mode, and `color-scheme` is hardcoded to `dark`. The decisive blocker is that the app's centerpiece — the canvas timeline — duplicates its entire palette as frozen hex in a `C` object (`WaveformTimeline.tsx:36-50`), so any theme swap would leave the editor on the old colors. Accessibility is the other weak axis: no focus styles anywhere, no reduced-motion guard, unlabeled inspector controls, unannounced banners, and a mouse-only canvas.

Ship-blocking? No. But the theming refactor below is exactly the work that was requested, and it's cheap to do now and expensive later.

---

## 2. Architecture & separation

### Strengths

- **Clean four-layer separation.** Components are presentational; hooks own state; `api.ts`/`project.ts`/`files.ts` own Tauri IPC; `types.ts` mirrors the Rust wire format. No component calls `invoke()` except `App.tsx`'s one `app_info` call.
- **`useAudio.ts` is exemplary.** The `userDirty`/`ready` refs correctly stop a transiently-missing device from clobbering saved prefs (documented at 51-54), `resolveSelection` centralizes fallback logic, and stream cleanup on re-open is handled.
- **Correct canvas-vs-DOM boundary.** High-frequency waveform/interaction on one canvas (perf); meters, inspector, toolbar, file bar in DOM/React (a11y + simplicity).
- **Pure helpers extracted** (`drawFade`, `drawClipWave`, `fmtTime`, `findClip`, `laneTopForY`) as module-level functions; `peaks.ts` binary parsing is isolated and well-commented.
- **Shallow prop drilling.** Deepest chain is `App → WaveformTimeline → Inspector`; Context would be premature at this size.

### Prioritized issues

| Pri    | Issue                                                                                                                                                                                          | Where                                                               | Impact                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **P1** | 954-line god-component mixing 5 concerns: canvas render (215-394), hit-test/pointer (407-536), transport (90-137), keyboard (560-584), snapping (176-212), _and_ the whole Inspector (704-829) | `WaveformTimeline.tsx`                                              | Nothing is unit-testable in isolation; all concerns share one render scope                                           |
| **P1** | `useProject.error` never rendered — failed edits fail silently                                                                                                                                 | `useProject.ts:7,25-27`; `App.tsx:56-57`                            | Every move/trim/split/delete/fade/undo routes through `run()`; on reject the clip snaps back with **zero** feedback  |
| **P2** | `ProjectApi` rebuilt with fresh closures every render                                                                                                                                          | `useProject.ts:30-49`                                               | Unstable `api` identity tears down/re-registers the window keydown listener (584) every render; memoization defeated |
| **P2** | Fade curves stringly-typed, forcing `as never` casts                                                                                                                                           | `project.ts:15-16`; `WaveformTimeline.tsx:521,532,768,777,796,805`  | `as never` disables checking entirely — a mistyped curve name would compile                                          |
| **P2** | Imperative render triggers: `drawRef.current = draw` assigned _during render_ (396) + throwaway `tick` force-update (85)                                                                       | `WaveformTimeline.tsx:85,396,463,480,535`                           | Impure side effect during render, unsafe under StrictMode/concurrent; couples render model to manual invalidation    |
| **P3** | `App` effect depends on whole unstable `project` object                                                                                                                                        | `App.tsx:30-35`                                                     | Effect re-runs every render (benign, guarded by ref, but misleading)                                                 |
| **P3** | Dead code: `listHosts`/`HostInfo`, `PlaybackStatus.paused`                                                                                                                                     | `api.ts:17-19`; `types.ts:16-19`; `project.ts:73`                   | Zero call sites; implies capabilities that aren't wired                                                              |
| **P3** | Double peak cache + `project.ts` mixes types with IPC wrappers                                                                                                                                 | `peaks.ts:72-81` vs `WaveformTimeline.tsx:72,150-165`; `project.ts` | Two caches for one dataset; inconsistent with the `api.ts`/`types.ts` convention                                     |

### Recommendations

1. **Split `WaveformTimeline.tsx`** into: `Inspector.tsx` (already self-contained, ~125 lines), a `useTransport` hook, a `useTimelineInteraction` hook (drag ref, hit-test, handlers, snapping), and a **pure renderer module** (move `draw()` next to the `draw*` helpers, take state as args). The component becomes composition + layout.
2. **Stabilize `ProjectApi`** — wrap returned methods in `useCallback` or the object in `useMemo`; fix `App.tsx:35` to depend on `project.refresh`, not `project`.
3. **Surface `useProject.error`** as an error banner in `App.tsx` beside `audio.error`.
4. **Type the curves** as `FadeCurve`; delete every cast.
5. **Move `drawRef` assignment** into a `useEffect`/ref-callback; reconsider whether cursor-driving interaction state should be React state instead of `tick`.
6. **Delete or wire the dead code**; consolidate peak caches into `peaks.ts`; move `ProjectView`/`ClipView`/`TrackView` into `types.ts`.

---

## 3. Theming & styling readiness — the central ask

The goal: **a rebrand or light/dark swap = edit one file, and the canvas follows.** Today neither holds. Here is the concrete target architecture.

### 3.1 Split tokens from components — `src/styles/tokens.css`

Introduce a two-tier token layer (primitives → semantic aliases). `App.css` consumes **only** semantic tokens.

```css
:root {
  /* primitives */
  --gray-950: #0e1116;
  --gray-900: #151a21;
  --gray-700: #2a323d;
  --blue-400: #4cc2ff;
  --red-500: #f85149;
  --green-500: #3fb950;
  --amber-500: #d29922;

  /* semantic — color */
  --color-surface: var(--gray-950);
  --color-panel: var(--gray-900);
  --color-border: var(--gray-700);
  --color-text: #e6edf3;
  --color-text-muted: #8b97a6;
  --color-accent: var(--blue-400);
  --color-ok: var(--green-500);
  --color-warn: var(--amber-500);
  --color-err: var(--red-500);
  --color-focus-ring: var(--blue-400);

  /* canvas colors — shared by CSS AND the renderer */
  --wave: var(--blue-400);
  --wave-lane: #12171e;
  --wave-lane-alt: #0f141a;
  --wave-grid: #232b35;
  --wave-clip: #1c2530;
  --wave-clip-sel: #1d4a6b;
  --wave-clip-edge: #2b6a93; /* -> real hex */
  --wave-snap: var(--amber-500);
  --wave-playhead: var(--red-500);
  --wave-fade-fill: color-mix(in srgb, var(--color-surface) 55%, transparent);

  /* spacing scale */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2.5rem;

  /* radius scale */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;

  /* type scale + family */
  --font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-size-xs: 0.72rem;
  --font-size-sm: 0.85rem;
  --font-size-md: 1rem;
  --font-size-lg: 1.25rem;
  --font-size-xl: 1.75rem;
  --font-size-2xl: 2.5rem;
}
```

This kills the scattered magic numbers (7 distinct radii, 6 spacing values, ad-hoc font sizes flagged across `App.css`) and gives one source of truth.

### 3.2 Light/dark via `data-theme`

Drop the hardcoded `color-scheme: dark`. Set `data-theme` on `<html>` so it's runtime-toggleable, and provide a `prefers-color-scheme` default.

```css
:root[data-theme="light"] {
  --color-surface: #f6f8fa;
  --color-panel: #fff;
  --color-border: #d0d7de;
  --color-text: #1f2328;
  --color-text-muted: #59636e;
  --wave-lane: #eef1f4;
  --wave-clip: #dbe4ee;
  --wave-fade-fill: color-mix(in srgb, #fff 55%, transparent);
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    /* same light block */
  }
}
```

Because states are already derived with `color-mix` (good — keep that), most hover/border/translucent values re-derive automatically once the base token flips.

### 3.3 Make the canvas read tokens (the decisive fix)

Delete the frozen `C` object (`WaveformTimeline.tsx:36-50`). Canvas can't read CSS vars, so resolve them from `getComputedStyle` at draw time into a memoized object, recomputed only on a theme-change signal:

```ts
function readCanvasTheme(): CanvasColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    wave: v("--wave"),
    lane: v("--wave-lane"),
    laneAlt: v("--wave-lane-alt"),
    grid: v("--wave-grid"),
    clip: v("--wave-clip"),
    clipSel: v("--wave-clip-sel"),
    clipEdge: v("--wave-clip-edge"),
    snap: v("--wave-snap"),
    playhead: v("--wave-playhead"),
    fadeFill: v("--wave-fade-fill"),
    font: `${v("--font-size-xs")} ${v("--font-family")}`, // replaces the "10px system-ui" literal at :238
  };
}
```

Recompute via a `MutationObserver` on `<html data-theme>` (or a redraw trigger). Also tokenize the meter track gradient (`App.css:213-221`, currently `#14361f`/`#3a3416`/`#3a1616`) so the meter's green/amber/red zones stay in sync with the `--color-ok/warn/err` fill.

### 3.4 Prioritized theming roadmap

1. **P0** — Create `tokens.css` with semantic color aliases + spacing/radius/type scales; point `App.css` at semantic tokens only.
2. **P0** — Replace the canvas `C` object with `getComputedStyle`-resolved, theme-signal-memoized colors; add `--wave-*` tokens for the currently canvas-only colors (lane, grid, clip, snap, fade fill).
3. **P0** — Add `[data-theme]` overrides + `prefers-color-scheme`; drop hardcoded `color-scheme: dark`; toggle on `<html>`.
4. **P1** — Tokenize the meter gradient and the canvas fade-fill literal (`WaveformTimeline.tsx:871`); tokenize the canvas font.
5. **P2** — Consider CSS-module scoping or at least splitting the 574-line `App.css` per component, so the token layer and component styles are versioned/owned independently.

---

## 4. Accessibility & best practices — key gaps

- **No focus styles anywhere (WCAG 2.4.7 fail).** Every control styles `:hover`, none styles `:focus`/`:focus-visible`; custom bg/border suppress the UA ring. Add globally:
  `:focus-visible { outline:2px solid var(--color-focus-ring); outline-offset:2px; }` (ensure ≥3:1 against adjacent surface).
- **Reduced motion ignored (WCAG 2.3.3).** Title blink (`App.css:53-57`) and rec-pulse (330-337) run unconditionally. Wrap in `@media (prefers-reduced-motion: reduce){ .cursor,.rec-square{ animation:none } }`.
- **Unlabeled inspector controls.** Gain/fade sliders and number inputs use `<span class=insp-label>` text, not `<label htmlFor>`/`aria-label` (`WaveformTimeline.tsx:747-825`) — SR announces only "slider"/"spin button." `DeviceSelector` already does this right; copy the pattern.
- **Banners not announced.** `.notice`/`.error-banner` are plain `<p>` (`App.tsx:56-57`) — add `role="alert"` + `aria-live` ("polite"/"assertive").
- **Timeline is mouse-only & keyboard-unreachable.** The `<canvas>` has no `tabindex`/`role`/`aria`; selection/move/trim are mouse-only. Add `tabindex`, `role="application"`, `aria-label` so it's at least focusable/announced.
- **Color-only state.** Selection (brighter fill), clip warning (color), and error (red text/border) have no non-visual equivalent — pair each with a text/icon cue.

---

## 5. What Audacity does right

Audacity is a 25-year-old, mouse-first destructive editor, so not everything translates to a modern non-destructive clip timeline like Waver — but its metering, transport, and selection/zoom model are battle-tested and worth copying almost verbatim. The through-line of its best controls is _low-friction directness_: a meter you click to arm monitoring, a selection you make by dragging on the waveform, a clip you grab by an obvious handle.

### Adoptable controls

- **Click-to-monitor recording meter** — the record meter arms live level monitoring the instant you click it (right-click → "Start Monitoring"), _before_ you hit record, so you can set input gain and check for clipping without committing to a take. Waver's meter should monitor on click, not only while recording.
- **Meter color gradient + dB scale** — green below ~-12 dB, yellow toward -6 dB, red above -6 dB, on a log dB scale (optional linear view). The color zones give an at-a-glance "am I hot?" read; log scale matches where a usable recording actually sits.
- **Peak-hold trio: current / recent-peak / max-peak** — instantaneous bar + a short-lived recent-peak tick + a persistent max-peak bar that stays after stop. Transients flash by too fast to catch, so the held peaks are what tell you whether you clipped.
- **Dedicated latching clip indicator** — a red bar that latches on at 4+ consecutive max samples and stays lit until reset: a binary, unmissable "you clipped" flag separate from the moving bar. Copy the latch-until-reset behavior exactly.
- **Resizable / detachable meter** — same widget, compact for a glance or enlarged with a numeric scale for careful gain-staging. Give Waver's meter a compact/large toggle.
- **Distinct Pause vs Stop** — Pause freezes the cursor to resume in place; Stop is the gate _into edit mode_ (you can't edit while playing/paused). This removes a whole class of "why won't it let me select" confusion. Also adopt **Loop** (loop selection) and **Play-at-Speed** as first-class transport buttons.
- **Spacebar play/stop + timeline quick-play** — clicking the ruler starts playback from that point _without moving the edit selection_, so you audition "what's here?" without destroying a carefully-made selection. Separate the preview playhead from the edit selection.
- **Click-drag time selection as a first-class object** that transport, zoom, and effects all act on — unifies "what to hear" and "what to edit" into one gesture (Shift-click to extend).
- **Consistent zoom: Zoom-to-Selection (Ctrl+E), Fit-to-Window (Ctrl+F), stable zoom keys, wheel-zoom at cursor** — "select the thing, one key, it fills the screen" is the fastest navigation loop; Fit-to-Window is the universal "show me everything" escape hatch.
- **Split at cursor (Ctrl+I)** — atomic non-destructive clip split, one key, no dialog, reversible.
- **Clip title-bar handle** — a rounded bar at the clip top: drag = move (along time or across tracks), double-click = rename — distinct from the waveform body (drag = select), so "move clip" and "select inside clip" never collide. (Waver already splits edge-trim vs body; add a top move/rename handle.)
- **Non-destructive edge-trim** (audio hidden, not deleted, recoverable) + Alt-drag time-stretch. Trims never lose material.
- **Boundary Snap Guides** — snap to clip edges, label markers, and (optionally) **zero-crossings**, with a visible guide line; zero-crossing snap prevents click/pop at cut points.
- **Per-track Control Panel** — gain + pan sliders, one-click Mute/Solo, collapse, and a per-track dropdown: everything affecting one track lives _with_ that track. Maps directly onto Waver's inspector/mixer.
- **Waveform display options** — dB vs linear amplitude, waveform+spectrogram, vertical zoom. At minimum give Waver a linear/dB toggle and vertical zoom.
- **Label track / markers** — a dedicated lane of point/region labels used as edit markers, snap targets, and named jump points.
- **Discoverable, remappable shortcuts** — every menu item shows its shortcut, with a searchable reference and full rebinding.

### Pain points to avoid

- **Destructive-by-default editing** — Waver's non-destructive clip model is already the right call; keep it.
- **Non-realtime, dialog-driven effects** (apply → listen → undo → retweak). Prefer realtime effects with live monitoring; never gate audition behind "Apply."
- **Modal tool switching** (Selection/Envelope/Draw/Zoom where the same drag means different things). A context-aware pointer (edge = trim, body = select, top = move) is better _only if every hot-zone is visually explicit_ (cursor change + hover affordance) so intent is never a guess.
- **"Can't edit while playing" with no signposting** — keep the Stop-to-edit gate, but surface the state ("stop to edit") instead of silently ignoring input.
- **Invisible hidden audio in trimmed clips** — if Waver hides trimmed material, show a folded-edge/handle affordance that hidden audio exists.
- **Fragile multi-file project format** — use a single self-contained project file from day one (Waver's single-JSON approach is right; keep source refs portable).
- **Tiny default meters** — make Waver's meter prominent by default, not something users must discover they can resize.

## 6. What Ableton does right

Ableton is a masterclass in **direct manipulation on a fixed canvas**: one dockable window, no floating dialogs, edits done by grabbing an affordance _on_ the object, and a consistent modifier grammar learned once and applied everywhere. Highest-value adoptions for Waver:

- **Fade controls ON the clip.** Draggable top-corner handles create fade-in/out; a curve-shape handle bends the slope; overlapping two clips on a track auto-creates an equal-power crossfade. _The fade length IS the visible triangle_ — no dialog, no separate tool. (Directly replaces Waver's inspector-only fade fields.)
- **Loop/selection brace with three grab-zones** — drag-left = start, drag-right = end, drag-middle = move without resizing. One object, three operations, disambiguated by grab-zone; prevents the classic "moved it and accidentally resized it" error.
- **One resizable window + persistent bottom inspector** that re-populates from the current selection (clip → gain/pitch/warp/loop/envelopes; track → device chain) and never changes position. Waver already has an inspector — make it this single persistent, selection-driven surface rather than an inline component.
- **Snap on by default, adaptive grid density tied to zoom, one-key toggle, momentary bypass modifier** (hold to bypass; hold to temporarily _enable_ when off — so you can't get stuck in the wrong mode). Snap to other clips' edges and markers, not just gridlines.
- **One consistent modifier grammar across every draggable control:** Cmd/Ctrl-drag = fine/high-res, Shift = constrain, Alt/Cmd-drag = duplicate, double-click = reset-or-create-point, right-click = object-scoped context menu. ~5 verbs instead of dozens of control-specific behaviors.
- **Track color as identity** — assign a color per track, propagate it to that track's clips and its meter so the eye tracks a part across the whole arrangement.
- **Track headers carry fader + Mute/Solo/Arm with redundant encoding** — armed = red, muted tracks' meters grey out (status readable peripherally, not color-alone) — plus multi-select so one click sets state on all selected tracks. (Also satisfies §4's color-only-state gap.)
- **Meters show peak + RMS together, expand on drag** to reveal dB ticks + numeric field + **click-to-reset peak-hold**. Waver's meter already uses `--ok/--warn/--err` — extend it to peak-hold and expand-on-drag.
- **Hover-reveal handles + cursor-shape hints** — fades/loop-ends/envelope points stay hidden until you hover, keeping clips clean at rest while staying discoverable; the cursor previews the drag.
- **Progressive disclosure by lane height** — a clip exposes more controls (e.g. fade handles) only above a minimum lane height, scaling from overview to surgical edit with no separate mode.
- **Deep linear undo covering mixer + clip edits**, so direct-manipulation experimentation is always safe (pairs with fixing Waver's silent-error path in §2).
- **Desaturated dark theme where saturated color = signal** (clip color, playhead, armed, selection), not chrome — reinforces the §3 token direction: keep chrome neutral, reserve `--color-accent`/state colors for content.

---

## 7. Prioritized roadmap

**P0 — theming readiness (the requested work):**

1. Create `src/styles/tokens.css` with semantic color aliases + `--space-*`/`--radius-*`/`--font-size-*` scales; make `App.css` consume semantic tokens only.
2. Replace the canvas `C` object with `getComputedStyle`-resolved, theme-signal-memoized colors, and add `--wave-*` tokens so canvas and CSS share one palette.
3. Add `[data-theme]` + `prefers-color-scheme` overrides, toggle on `<html>`, and drop hardcoded `color-scheme: dark`.

**P1 — high-value UX + robustness:** 4. Add global `:focus-visible` ring and a `prefers-reduced-motion` guard. 5. Surface `useProject.error` as a banner (`role="alert"`) so failed edits stop failing silently. 6. Extract `Inspector.tsx` and make it the single persistent, selection-driven inspector surface (Ableton pattern). 7. Move fade controls onto the clip: hover-revealed top-corner handles + curve handle + auto-crossfade on overlap. 8. Tokenize the meter gradient + canvas fade/font literals; extend the meter to peak+RMS with click-to-reset peak-hold.

**P2 — structural + interaction depth:** 9. Split `WaveformTimeline` into `useTransport` / `useTimelineInteraction` / pure renderer; stabilize `ProjectApi` via `useCallback`/`useMemo`. 10. Type fade curves as `FadeCurve` (delete `as never`); remove `drawRef`-during-render + `tick` force-update. 11. Add keyboard reachability to the canvas (`tabindex`/`role="application"`/`aria-label`) and labels to inspector controls; pair every color-only state with a text/icon cue. 12. Adopt a unified modifier grammar (Cmd=fine, Shift=constrain, Alt=duplicate, dbl-click=reset), a three-zone loop/selection brace, and track-color-as-identity propagated to clips + meter.

> Note: the **Audacity adoptions (§5) are provisional** because that research input came through empty — re-run it to firm up P2 UX items.
