import { useEffect, useRef, useState } from "react";
import type { useAudio } from "../audio/useAudio";
import { DeviceSelector } from "./DeviceSelector";
import { Meter } from "./Meter";
import { IconGear } from "./icons";

function fmtElapsed(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Compact audio cluster for the top bar: a device-settings popover, a live input
 *  meter, and the record button. Keeps the recorder controls in the chrome (Audacity
 *  pattern) rather than a scrolling panel. */
export function AudioControls({
  audio,
  onToggleRecord,
}: {
  audio: ReturnType<typeof useAudio>;
  onToggleRecord: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchorLeft, setAnchorLeft] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputName =
    audio.inputs.find((d) => d.id === audio.inputId)?.name ?? "No input";

  const toggle = () => {
    // Opening leftward (right:0) would clip when the button sits near the left edge
    // (e.g. the top bar has wrapped) — anchor to the left instead.
    if (!open && wrapRef.current) {
      const r = wrapRef.current.getBoundingClientRect();
      setAnchorLeft(r.right - 360 < 8);
    }
    setOpen((o) => !o);
  };

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="audio-controls">
      <div className="ac-device" ref={wrapRef}>
        <button
          type="button"
          className={`ac-device-btn${open ? " open" : ""}`}
          onClick={toggle}
          title="Audio device settings"
          aria-expanded={open}
        >
          <IconGear />
          <span className="ac-device-name">{inputName}</span>
        </button>
        {open && (
          <div
            className={`ac-popover${anchorLeft ? " anchor-left" : ""}`}
            role="dialog"
            aria-label="Audio settings"
          >
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
              disabled={audio.recording}
              resolvedBuffer={audio.resolvedBuffer}
            />
          </div>
        )}
      </div>

      <Meter channels={audio.levels} compact />

      <button
        type="button"
        className={`rec-btn ${audio.recording ? "stop" : "start"}`}
        disabled={!audio.canRecord}
        onClick={onToggleRecord}
        title={audio.recording ? "Stop recording" : "Record"}
      >
        <span className={audio.recording ? "rec-square" : "rec-dot"} />
        {audio.recording ? fmtElapsed(audio.recElapsed) : "Rec"}
      </button>
    </div>
  );
}
