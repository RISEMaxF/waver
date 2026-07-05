import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAudio } from "./audio/useAudio";
import { DeviceSelector } from "./components/DeviceSelector";
import { Meter } from "./components/Meter";
import "./App.css";

interface AppInfo {
  name: string;
  version: string;
}

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const audio = useAudio();

  useEffect(() => {
    invoke<AppInfo>("app_info")
      .then(setInfo)
      .catch(() => {});
  }, []);

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
    </main>
  );
}

export default App;
