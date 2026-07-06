import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAudio } from "./audio/useAudio";
import { useProject } from "./audio/useProject";
import { setRecordTarget } from "./audio/project";
import { AudioControls } from "./components/AudioControls";
import { FileBar } from "./components/FileBar";
import { MediaPool } from "./components/MediaPool";
import { WaveformTimeline } from "./components/WaveformTimeline";
import "./App.css";

interface AppInfo {
  name: string;
  version: string;
}

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [poolMsg, setPoolMsg] = useState<string | null>(null);
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

  // Guard the window close / quit against unsaved changes (F1). Registered once; reads
  // the live dirty flag via a ref.
  const dirtyRef = useRef(false);
  dirtyRef.current = project.dirty;
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (event) => {
      if (!dirtyRef.current) return; // clean — let it close
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

  // Refresh the project timeline whenever a new take is recorded.
  const takeCount = useRef(0);
  useEffect(() => {
    if (audio.takes.length !== takeCount.current) {
      takeCount.current = audio.takes.length;
      project.markDirty();
      project.refresh();
    }
  }, [audio.takes, project]);

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
          />
        </div>
        <AudioControls audio={audio} onToggleRecord={onToggleRecord} />
      </header>

      {(audio.notice || audio.error || project.error || poolMsg) && (
        <div className="banners">
          {audio.notice && (
            <p className="notice" role="status" aria-live="polite">
              {audio.notice}
            </p>
          )}
          {audio.error && (
            <p className="error-banner" role="alert">
              {audio.error}
            </p>
          )}
          {project.error && (
            <p className="error-banner" role="alert">
              {project.error}
            </p>
          )}
          {poolMsg && (
            <p
              className="error-banner"
              role="alert"
              onClick={() => setPoolMsg(null)}
            >
              {poolMsg}
            </p>
          )}
        </div>
      )}

      <main className="stage">
        <MediaPool
          project={project.project}
          outputId={audio.outputId}
          onChanged={() => {
            project.markDirty();
            project.refresh();
          }}
          onError={setPoolMsg}
        />
        <WaveformTimeline
          project={project.project}
          api={project}
          outputId={audio.outputId}
          recording={audio.recording}
          recWave={audio.recWave}
          recordTargetRef={recordTargetRef}
        />
      </main>
    </div>
  );
}

export default App;
