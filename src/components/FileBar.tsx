import { useCallback, useEffect, useRef, useState } from "react";
// Export settings live in a popover: format/bit-depth are touched once per
// session, so they don't deserve permanent top-bar space (Audacity 4 pattern).
import { ask } from "@tauri-apps/plugin-dialog";
import {
  exportProjectDialog,
  importAudioDialog,
  loadProjectDialog,
  newProject,
  saveProjectDialog,
  saveProjectToPath,
  type ExportBitDepth,
  type ExportFormat,
} from "../audio/files";
import type { ProjectView } from "../audio/project";
import { fmtTimecode } from "./timeline/renderer";
import { ContextMenu, type MenuState } from "./timeline/ContextMenu";
import { loadProjectFromPath } from "../audio/files";
import { IconChevronDown } from "./icons";

const RECENT_KEY = "waver-recent";
const readRecents = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
};
const pushRecent = (path: string) => {
  const list = [path, ...readRecents().filter((p) => p !== path)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
};
import {
  IconExport,
  IconImport,
  IconNew,
  IconOpen,
  IconSave,
  IconSaveAs,
} from "./icons";

interface Props {
  project: ProjectView | null;
  onChanged: () => void; // refresh the project view
  dirty: boolean;
  markDirty: () => void;
  markClean: () => void;
  onError: (msg: string) => void; // failures surface as dismissible toasts (W-05)
  /** Current timeline range selection (frames) - enables "Export selection". */
  exportRange: { start: number; end: number } | null;
}

/** Confirm discarding unsaved changes before a destructive project switch (F1). */
async function okToDiscard(dirty: boolean, action: string): Promise<boolean> {
  if (!dirty) return true;
  return ask(`You have unsaved changes. Discard them and ${action}?`, {
    title: "Unsaved changes",
    kind: "warning",
  });
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function FileBar({
  project,
  onChanged,
  dirty,
  markDirty,
  markClean,
  onError,
  exportRange,
}: Props) {
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [bitDepth, setBitDepth] = useState<ExportBitDepth>("int24");
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [recentMenu, setRecentMenu] = useState<MenuState | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const exportBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node))
        setExportOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [exportOpen]);
  const [msg, setMsg] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);

  // A project opened from the OS (double-click) binds here so Save targets it.
  useEffect(() => {
    const onOpened = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (!path) return;
      setProjectPath(path);
      pushRecent(path);
      setMsg(`Opened ${basename(path)}`);
    };
    window.addEventListener("waver:opened-project", onOpened);
    return () => window.removeEventListener("waver:opened-project", onOpened);
  }, []);

  // Success text is transient (4s) and yields the moment new edits land, so it can
  // never contradict the dirty dot (W-05).
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(id);
  }, [msg]);
  useEffect(() => {
    if (dirty) setMsg(null);
  }, [dirty]);

  const sampleRate = project?.sample_rate ?? 48000;
  const hasContent =
    !!project && project.tracks.some((t) => t.clips.length > 0);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setBusyAction(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      onError(`${label} failed - ${e}`);
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  // Save / Save As are also keyboard commands (⌘S / ⇧⌘S; W-04).
  const doSave = useCallback(async () => {
    await run("Save", async () => {
      if (projectPath) {
        await saveProjectToPath(projectPath);
        pushRecent(projectPath);
        markClean();
        setMsg(`Saved ${basename(projectPath)}`);
      } else {
        const p = await saveProjectDialog();
        if (p) {
          setProjectPath(p);
          pushRecent(p);
          markClean();
          setMsg(`Saved ${basename(p)}`);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, markClean]);

  const doSaveAs = useCallback(async () => {
    await run("Save As", async () => {
      const p = await saveProjectDialog();
      if (p) {
        setProjectPath(p);
        pushRecent(p);
        markClean();
        setMsg(`Saved ${basename(p)}`);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markClean]);

  const openRecent = (path: string) =>
    run("Open", async () => {
      if (!(await okToDiscard(dirty, "open another project"))) return;
      const r = await loadProjectFromPath(path);
      setProjectPath(r.path);
      pushRecent(r.path);
      markClean();
      onChanged();
      setMsg(
        r.missing_sources.length
          ? `Opened ${basename(r.path)} - ${r.missing_sources.length} source file(s) missing`
          : `Opened ${basename(r.path)}`,
      );
    });

  const saveKeys = useRef({ doSave, doSaveAs, busy });
  saveKeys.current = { doSave, doSaveAs, busy };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (saveKeys.current.busy) return; // same guard as the buttons
        if (e.shiftKey) saveKeys.current.doSaveAs();
        else saveKeys.current.doSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="filebar">
      <div className="filebar-group">
        <button
          type="button"
          className="tbtn icon-only"
          disabled={busy}
          title="New project"
          aria-label="New project"
          onClick={() =>
            run("New", async () => {
              if (!(await okToDiscard(dirty, "start a new project"))) return;
              await newProject();
              setProjectPath(null);
              markClean();
              onChanged();
              setMsg("New project");
            })
          }
        >
          <IconNew />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          aria-label="Open project"
          title="Open project"
          disabled={busy}
          onClick={() =>
            run("Open", async () => {
              if (!(await okToDiscard(dirty, "open another project"))) return;
              const r = await loadProjectDialog();
              if (r) {
                setProjectPath(r.path);
                pushRecent(r.path);
                markClean();
                onChanged();
                setMsg(
                  r.missing_sources.length
                    ? `Opened ${basename(r.path)} - ${r.missing_sources.length} source file(s) missing`
                    : `Opened ${basename(r.path)}`,
                );
              }
            })
          }
        >
          <IconOpen />
        </button>
        <button
          type="button"
          className="tbtn icon-only tbtn-narrow"
          aria-label="Open recent project"
          aria-haspopup="menu"
          title="Open recent"
          disabled={busy}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const recents = readRecents();
            setRecentMenu({
              x: r.left,
              y: r.bottom + 4,
              items: recents.length
                ? [
                    ...recents.map((p) => ({
                      label: basename(p),
                      onClick: () => openRecent(p),
                    })),
                    "sep" as const,
                    {
                      label: "Clear recent",
                      onClick: () => localStorage.removeItem(RECENT_KEY),
                    },
                  ]
                : [
                    {
                      label: "No recent projects",
                      disabled: true,
                      onClick: () => {},
                    },
                  ],
            });
          }}
        >
          <IconChevronDown size={12} />
        </button>
        <button
          type="button"
          className={`tbtn icon-only${busyAction === "Save" ? " working" : ""}`}
          disabled={busy}
          aria-label="Save project"
          title={
            busyAction === "Save"
              ? "Saving…"
              : projectPath
                ? `Save to ${basename(projectPath)} (⌘S)`
                : "Save project (⌘S)"
          }
          onClick={doSave}
        >
          <IconSave />
        </button>
        <button
          type="button"
          className={`tbtn icon-only${busyAction === "Save As" ? " working" : ""}`}
          disabled={busy}
          aria-label="Save As"
          title={
            busyAction === "Save As" ? "Saving…" : "Save to a new file (⇧⌘S)"
          }
          onClick={doSaveAs}
        >
          <IconSaveAs />
        </button>
        <span
          className="filebar-project"
          title={projectPath ?? "Unsaved project"}
        >
          {dirty && (
            <span
              className="dirty-dot"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            >
              ●
            </span>
          )}
          <span className="filebar-project-name">
            {projectPath ? basename(projectPath) : "Untitled"}
          </span>
        </span>
      </div>

      <span className="tb-div" />

      <div className="filebar-group">
        <button
          type="button"
          className={`tbtn icon-only${busyAction === "Import" ? " working" : ""}`}
          aria-label="Import audio"
          title={busyAction === "Import" ? "Importing…" : "Import audio file"}
          disabled={busy}
          onClick={() =>
            run("Import", async () => {
              const r = await importAudioDialog();
              if (r) {
                markDirty();
                setMsg(`Imported ${r.name} (${r.duration_secs.toFixed(1)}s)`);
                onChanged();
              }
            })
          }
        >
          <IconImport />
        </button>
        <div className="filebar-export" ref={exportRef}>
          <button
            type="button"
            ref={exportBtnRef}
            className={`tbtn icon-only${busyAction === "Export" ? " working" : ""}${exportOpen ? " active" : ""}`}
            disabled={busy}
            aria-label="Export mixdown"
            aria-haspopup="dialog"
            aria-expanded={exportOpen}
            title={busyAction === "Export" ? "Exporting…" : "Export mixdown…"}
            onClick={() => setExportOpen((o) => !o)}
          >
            <IconExport />
          </button>
          {exportOpen && (
            <div
              className="ac-popover anchor-left export-popover"
              role="dialog"
              aria-label="Export mixdown"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setExportOpen(false);
                  exportBtnRef.current?.focus();
                }
              }}
            >
              <h3 className="devsel-heading">Export mixdown</h3>
              <label className="export-row">
                <span>Format</span>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as ExportFormat)}
                >
                  <option value="wav">WAV</option>
                  <option value="flac">FLAC</option>
                  <option value="mp3">MP3</option>
                  <option value="ogg">OGG (Vorbis)</option>
                  <option value="opus">Opus</option>
                </select>
              </label>
              <label className="export-row">
                <span>Bit depth</span>
                <select
                  value={bitDepth}
                  onChange={(e) =>
                    setBitDepth(e.target.value as ExportBitDepth)
                  }
                  disabled={
                    format === "ogg" || format === "mp3" || format === "opus"
                  }
                >
                  <option value="int16">16-bit</option>
                  <option value="int24">24-bit</option>
                  <option value="float32">32-bit float</option>
                </select>
              </label>
              {exportRange && (
                <button
                  type="button"
                  className="tbtn export-go"
                  disabled={busy}
                  onClick={() => {
                    setExportOpen(false);
                    run("Export", async () => {
                      const p = await exportProjectDialog(
                        format,
                        bitDepth,
                        sampleRate,
                        2,
                        exportRange,
                      );
                      if (p) setMsg(`Exported selection ${basename(p)}`);
                    });
                  }}
                >
                  <IconExport />
                  <span>
                    Export selection (
                    {fmtTimecode(exportRange.start / sampleRate)}
                    {" - "}
                    {fmtTimecode(exportRange.end / sampleRate)})
                  </span>
                </button>
              )}
              <button
                type="button"
                className="tbtn export-go"
                disabled={busy || !hasContent}
                title={
                  hasContent ? undefined : "Record or import something first"
                }
                onClick={() => {
                  setExportOpen(false);
                  run("Export", async () => {
                    const p = await exportProjectDialog(
                      format,
                      bitDepth,
                      sampleRate,
                      2,
                    );
                    if (p) setMsg(`Exported ${basename(p)}`);
                  });
                }}
              >
                <IconExport />
                <span>Export {format.toUpperCase()}</span>
              </button>
              {!hasContent && (
                <p className="export-hint">Record or import something first.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {msg && (
        <span className="filebar-msg" role="status" aria-live="polite">
          {msg}
        </span>
      )}
      {recentMenu && (
        <ContextMenu menu={recentMenu} onClose={() => setRecentMenu(null)} />
      )}
    </div>
  );
}
