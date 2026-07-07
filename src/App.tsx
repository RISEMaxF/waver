import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAudio } from "./audio/useAudio";
import { useProject } from "./audio/useProject";
import {
  autosaveProject,
  checkRecovery,
  discardRecovery,
  setRecordTarget,
} from "./audio/project";
import { loadProjectFromPath } from "./audio/files";
import { AudioControls } from "./components/AudioControls";
import { FileBar } from "./components/FileBar";
import { MediaPool } from "./components/MediaPool";
import { WaveformTimeline } from "./components/WaveformTimeline";
import { IconClose, IconMoon, IconSun } from "./components/icons";
import "./App.css";

/** One feedback toast. Notices self-dismiss; errors persist until dismissed (W-02). */
interface ToastMsg {
  kind: "notice" | "error";
  text: string;
  onDismiss: () => void;
}

function ToastItem({ toast }: { toast: ToastMsg }) {
  const { kind, text, onDismiss } = toast;
  // App re-renders ~10x/s from meter levels and the dismiss handlers are inline
  // arrows, so the timer must NOT key on onDismiss identity — it would reset forever.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (kind !== "notice") return;
    const id = setTimeout(() => dismissRef.current(), 6000);
    return () => clearTimeout(id);
  }, [kind, text]);
  return (
    <div
      className={`toast ${kind}`}
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "error" ? "assertive" : "polite"}
    >
      <span className="toast-text">{text}</span>
      <button
        type="button"
        className="toast-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <IconClose size={13} />
      </button>
    </div>
  );
}

/** Fixed overlay so feedback never reflows the workspace (W-02). */
function Toasts({ items }: { items: ToastMsg[] }) {
  if (items.length === 0) return null;
  return (
    <div className="toasts">
      {items.map((t) => (
        <ToastItem key={`${t.kind}:${t.text}`} toast={t} />
      ))}
    </div>
  );
}

/** Global fast tooltips: native title= tooltips honor a slow OS delay, so at hover
 *  time the nearest title is moved into data-tip (suppressing the native one) and a
 *  styled tip renders after 250 ms. Icon buttons keep their aria-labels for AT. */
function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(
    null,
  );
  const timer = useRef(0);
  useEffect(() => {
    const hide = () => {
      clearTimeout(timer.current);
      setTip(null);
    };
    const onOver = (e: MouseEvent) => {
      clearTimeout(timer.current);
      let el = e.target as HTMLElement | null;
      let holder: HTMLElement | null = null;
      while (el && el !== document.body) {
        if (el.title || el.dataset.tip) {
          holder = el;
          break;
        }
        el = el.parentElement;
      }
      if (!holder) {
        setTip(null);
        return;
      }
      if (holder.title) {
        holder.dataset.tip = holder.title;
        holder.removeAttribute("title");
      }
      const text = holder.dataset.tip ?? "";
      if (!text) {
        setTip(null);
        return;
      }
      const r = holder.getBoundingClientRect();
      timer.current = window.setTimeout(
        () => setTip({ text, x: r.left + r.width / 2, y: r.bottom + 8 }),
        250,
      );
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("wheel", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);
  if (!tip) return null;
  const x = Math.min(Math.max(tip.x, 12), window.innerWidth - 12);
  const y = Math.min(tip.y, window.innerHeight - 40);
  return (
    <div className="app-tooltip" style={{ left: x, top: y }} role="tooltip">
      {tip.text}
    </div>
  );
}

/** Light/dark toggle, top-bar far right (W-31). index.html sets data-theme before
 *  first paint; this persists the user's explicit choice (W-20). */
function ThemeToggle() {
  const [dark, setDark] = useState(
    document.documentElement.dataset.theme !== "light",
  );
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try {
      localStorage.setItem("waver-theme", next ? "dark" : "light");
    } catch {
      /* private mode etc. — theme still applies for this session */
    }
  };
  return (
    <button
      type="button"
      className="tbtn icon-only theme-toggle"
      onClick={toggle}
      title="Toggle light / dark theme"
      aria-label="Toggle theme"
    >
      {dark ? <IconSun /> : <IconMoon />}
    </button>
  );
}

interface AppInfo {
  name: string;
  version: string;
}

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [poolMsg, setPoolMsg] = useState<{
    kind: "notice" | "error";
    text: string;
  } | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [exportRange, setExportRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const audio = useAudio();
  const project = useProject();
  // Latest record target (armed track + playhead frame), kept fresh by the timeline so
  // record can commit it synchronously before starting (avoids a scrub/arm race).
  const recordTargetRef = useRef<{
    trackId: string | null;
    startFrame: number;
  }>({
    trackId: null,
    startFrame: 0,
  });

  useEffect(() => {
    invoke<AppInfo>("app_info")
      .then(setInfo)
      .catch(() => {});
  }, []);

  // Crash recovery: offer to restore the autosaved snapshot from a crashed or
  // force-quit session, then keep autosaving (debounced) while there are unsaved
  // edits. A clean close discards the snapshot, so the prompt only ever appears
  // after an unclean exit.
  const recoveryChecked = useRef(false);
  useEffect(() => {
    if (recoveryChecked.current) return;
    recoveryChecked.current = true;
    (async () => {
      try {
        const rec = await checkRecovery();
        if (!rec) return;
        const restore = await ask(
          "Waver closed with unsaved work. Restore your last session?",
          { title: "Restore session", kind: "info" },
        );
        if (restore) {
          await loadProjectFromPath(rec);
          project.markDirty();
          project.refresh();
        } else {
          await discardRecovery();
        }
      } catch {
        /* recovery is best-effort */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!project.dirty) return;
    const id = setTimeout(() => autosaveProject().catch(() => {}), 3000);
    const iv = setInterval(() => autosaveProject().catch(() => {}), 20000);
    return () => {
      clearTimeout(id);
      clearInterval(iv);
    };
  }, [project.dirty, project.project]);

  // Guard the window close / quit against unsaved changes (F1). Registered once; reads
  // the live dirty flag via a ref.
  const dirtyRef = useRef(false);
  dirtyRef.current = project.dirty;
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (event) => {
      if (!dirtyRef.current) return; // clean - let it close
      event.preventDefault();
      const discard = await ask(
        "You have unsaved changes. Discard them and quit?",
        { title: "Unsaved changes", kind: "warning" },
      );
      if (discard) {
        dirtyRef.current = false;
        await win.destroy();
      }
    });
    return () => {
      unlisten.then((u) => u());
    };
  }, []);

  // Refresh the project timeline whenever a new take is recorded, and remember the
  // committed clip so the timeline can select + reveal it (W-06).
  const takeCount = useRef(0);
  const [lastTake, setLastTake] = useState<{
    clipId: string;
    seq: number;
  } | null>(null);
  useEffect(() => {
    if (audio.takes.length !== takeCount.current) {
      takeCount.current = audio.takes.length;
      const newest = audio.takes[0];
      if (newest)
        setLastTake({ clipId: newest.clip_id, seq: audio.takes.length });
      project.markDirty();
      project.refresh();
    }
  }, [audio.takes, project]);

  // Place a pool source on the armed (else first) track at the playhead — the
  // keyboard/click alternative to drag-and-drop (W-15). recordTargetRef always holds
  // the timeline's live armed-track + playhead frame.
  const placeFromPool = useCallback(
    async (sourceId: string) => {
      const view = project.project;
      if (!view) return;
      const src = view.sources.find((s) => s.id === sourceId);
      if (!src) return;
      const spec = (start: number) => ({
        name: (src.path.split(/[\\/]/).pop() ?? "Clip").replace(/\.[^.]+$/, ""),
        source_id: src.id,
        source_channel: null,
        source_in: 0,
        source_out: src.frames,
        timeline_start: start,
        gain_db: 0,
        fade_in_len: 0,
        fade_in_curve: "linear" as const,
        fade_out_len: 0,
        fade_out_curve: "linear" as const,
      });
      const wanted = Math.max(0, recordTargetRef.current.startFrame);
      const armedId = recordTargetRef.current.trackId;
      const track = view.tracks.find((t) => t.id === armedId) ?? view.tracks[0];
      if (!track) {
        const nv = await project.addTrack();
        const t0 = nv?.tracks[0];
        if (t0) await project.paste(spec(wanted), t0.id);
        return;
      }
      // Same non-overlap fallback the canvas drop uses: bump past occupied space.
      const len = src.frames;
      const overlaps = track.clips.some(
        (c) =>
          wanted < c.timeline_start + (c.source_out - c.source_in) &&
          c.timeline_start < wanted + len,
      );
      const start = overlaps
        ? track.clips.reduce(
            (m, c) =>
              Math.max(m, c.timeline_start + (c.source_out - c.source_in)),
            0,
          )
        : wanted;
      await project.paste(spec(start), track.id);
    },
    [project],
  );

  // Toggle recording; refresh after starting so a just-created track (armed on the
  // backend when nothing was armed) shows up and the live waveform has a lane.
  const onToggleRecord = useCallback(async () => {
    if (audio.recording) {
      audio.stopRec();
      return;
    }
    // Commit the freshest target before starting, so a scrub/arm right before Rec can't
    // land the take on a stale frame/track.
    const t = recordTargetRef.current;
    await setRecordTarget(t.trackId, t.startFrame).catch(() => {});
    await audio.startRec();
    project.refresh();
  }, [audio, project]);

  return (
    <div className="app-shell">
      <TooltipLayer />
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <span className="brand-name">Waver</span>
            {info && <span className="brand-ver">v{info.version}</span>}
          </div>
          <FileBar
            project={project.project}
            onChanged={project.refresh}
            dirty={project.dirty}
            markDirty={project.markDirty}
            markClean={project.markClean}
            onError={setFileErr}
            exportRange={exportRange}
          />
        </div>
        <div className="topbar-right">
          <AudioControls audio={audio} />
          <ThemeToggle />
        </div>
      </header>

      <Toasts
        items={[
          audio.error && {
            kind: "error" as const,
            text: audio.error,
            onDismiss: audio.clearError,
          },
          project.error && {
            kind: "error" as const,
            text: project.error,
            onDismiss: project.clearError,
          },
          fileErr && {
            kind: "error" as const,
            text: fileErr,
            onDismiss: () => setFileErr(null),
          },
          audio.notice && {
            kind: "notice" as const,
            text: audio.notice,
            onDismiss: audio.clearNotice,
          },
          poolMsg && {
            kind: poolMsg.kind,
            text: poolMsg.text,
            onDismiss: () => setPoolMsg(null),
          },
        ].filter((t): t is ToastMsg => !!t)}
      />

      <main className="stage">
        <MediaPool
          project={project.project}
          outputId={audio.outputId}
          onChanged={() => {
            project.markDirty();
            project.refresh();
          }}
          onNotice={(text) => setPoolMsg({ kind: "notice", text })}
          onError={(text) => setPoolMsg({ kind: "error", text })}
          onPlace={placeFromPool}
        />
        <WaveformTimeline
          project={project.project}
          api={project}
          outputId={audio.outputId}
          recording={audio.recording}
          canRecord={audio.canRecord}
          onToggleRecord={onToggleRecord}
          recElapsed={audio.recElapsed}
          recWave={audio.recWave}
          recordTargetRef={recordTargetRef}
          lastTake={lastTake}
          onNotice={(text) => setPoolMsg({ kind: "notice", text })}
          inputLevels={audio.levels}
          onRangeChange={setExportRange}
        />
      </main>
    </div>
  );
}

export default App;
