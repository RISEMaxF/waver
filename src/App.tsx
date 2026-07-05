import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAudio } from "./audio/useAudio";
import { useProject } from "./audio/useProject";
import { DeviceSelector } from "./components/DeviceSelector";
import { Meter } from "./components/Meter";
import { Recorder } from "./components/Recorder";
import { WaveformTimeline } from "./components/WaveformTimeline";
import "./App.css";

interface AppInfo {
  name: string;
  version: string;
}

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const audio = useAudio();
  const project = useProject();

  useEffect(() => {
    invoke<AppInfo>("app_info")
      .then(setInfo)
      .catch(() => {});
  }, []);

  // Refresh the project timeline whenever a new take is recorded.
  const takeCount = useRef(0);
  useEffect(() => {
    if (audio.takes.length !== takeCount.current) {
      takeCount.current = audio.takes.length;
      project.refresh();
    }
  }, [audio.takes, project]);

  return (
    <main className="container">
      <header className="masthead">
        <h1>
          Waver
          <span className="cursor" />
        </h1>
        <p className="tagline">
          Non-destructive audio recorder &amp; multitrack editor
        </p>
        {info && (
          <p className="build-badge">
            {info.name} v{info.version} · Rust core connected
          </p>
        )}
      </header>

      {audio.notice && <p className="notice">{audio.notice}</p>}
      {audio.error && <p className="error-banner">{audio.error}</p>}

      <section className="panel">
        <h2>Input &amp; monitoring</h2>
        <div className="panel-body">
          <DeviceSelector
            inputs={audio.inputs}
            outputs={audio.outputs}
            selectedInputId={audio.inputId}
            selectedOutputId={audio.outputId}
            sampleRate={audio.sampleRate}
            bufferFrames={audio.bufferFrames}
            onSelectInput={audio.selectInput}
            onSelectOutput={audio.selectOutput}
            onSelectRate={audio.selectRate}
            onSelectBuffer={audio.selectBuffer}
            onRefresh={audio.refresh}
          />
          <Meter channels={audio.levels} />
        </div>
      </section>

      <section className="panel">
        <h2>Recording</h2>
        <div className="panel-body single">
          <Recorder
            recording={audio.recording}
            elapsed={audio.recElapsed}
            canRecord={audio.canRecord}
            takes={audio.takes}
            onStart={audio.startRec}
            onStop={audio.stopRec}
          />
        </div>
      </section>

      <section className="panel">
        <h2>Timeline</h2>
        <div className="panel-body single flush">
          <WaveformTimeline project={project.project} api={project} />
        </div>
      </section>
    </main>
  );
}

export default App;
