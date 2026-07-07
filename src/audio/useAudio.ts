import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeInput,
  inputBufferFrames,
  listDevices,
  loadSettings,
  openInput,
  saveSettings,
  startRecording,
  stopRecording,
} from "./api";
import type { ChannelLevel, DeviceInfo, RecordingResult } from "./types";

/** Pick a sensible default sample rate for a device: keep the saved one if valid,
 *  else prefer 48 kHz, else the device's first supported rate. */
function defaultRate(
  device: DeviceInfo | undefined,
  saved: number | null,
): number | null {
  const rates = device?.sample_rates ?? [];
  if (saved != null && rates.includes(saved)) return saved;
  if (rates.includes(48000)) return 48000;
  return rates[0] ?? null;
}

/** Channel count to capture for a device — all its channels (spec FR-2.4). */
function deviceChannels(device: DeviceInfo | undefined): number {
  if (!device || device.channels.length === 0) return 1;
  return Math.max(...device.channels);
}

interface Saved {
  input_device_id: string | null;
  output_device_id: string | null;
  sample_rate: number | null;
  buffer_frames: number | null;
}

export function useAudio() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [inputId, setInputId] = useState<string | null>(null);
  const [outputId, setOutputId] = useState<string | null>(null);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [bufferFrames, setBufferFrames] = useState<number | null>(null);
  const [resolvedBuffer, setResolvedBuffer] = useState<number | null>(null);
  const [levels, setLevels] = useState<ChannelLevel[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [takes, setTakes] = useState<RecordingResult[]>([]);
  const ready = useRef(false);
  // Live recording waveform: min/max buckets timestamped from record start, for the
  // timeline to draw a growing waveform on the armed track while recording.
  const recordingRef = useRef(false);
  const recWave = useRef<{
    start: number;
    buckets: { t: number; min: number; max: number }[];
  }>({ start: 0, buckets: [] });
  // Only persist selections that came from an explicit user action — never a
  // fallback we derived because a saved device was (transiently) absent. Otherwise
  // one launch with a device unplugged would overwrite the saved preference (FR-1.2).
  const userDirty = useRef(false);

  const inputs = devices.filter((d) => d.direction === "input");
  const outputs = devices.filter((d) => d.direction === "output");
  const selectedInput = inputs.find((d) => d.id === inputId);

  const resolveSelection = useCallback(
    (devs: DeviceInfo[], saved: Partial<Saved>) => {
      const ins = devs.filter((d) => d.direction === "input");
      const outs = devs.filter((d) => d.direction === "output");
      const missing: string[] = [];

      let chosenIn = saved.input_device_id
        ? ins.find((d) => d.id === saved.input_device_id)
        : undefined;
      if (saved.input_device_id && !chosenIn) missing.push("input");
      if (!chosenIn) chosenIn = ins.find((d) => d.is_default) ?? ins[0];

      let chosenOut = saved.output_device_id
        ? outs.find((d) => d.id === saved.output_device_id)
        : undefined;
      if (saved.output_device_id && !chosenOut) missing.push("output");
      if (!chosenOut) chosenOut = outs.find((d) => d.is_default) ?? outs[0];

      // Accumulate both fallbacks into a single notice; clear it when all is well.
      setNotice(
        missing.length
          ? `Saved ${missing.join(" & ")} device${missing.length > 1 ? "s" : ""} unavailable - using the default${missing.length > 1 ? "s" : ""}.`
          : null,
      );

      setInputId(chosenIn?.id ?? null);
      setOutputId(chosenOut?.id ?? null);
      setSampleRate(defaultRate(chosenIn, saved.sample_rate ?? null));
      setBufferFrames(saved.buffer_frames ?? null);
    },
    [],
  );

  // Initial load: devices + persisted settings.
  useEffect(() => {
    (async () => {
      try {
        const [devs, settings] = await Promise.all([
          listDevices(),
          loadSettings(),
        ]);
        setDevices(devs);
        resolveSelection(devs, settings);
      } catch (e) {
        setError(`Couldn't load audio devices/settings - ${e}`);
      } finally {
        ready.current = true;
      }
    })();
  }, [resolveSelection]);

  // Persist selection — but only when it originated from a user action.
  useEffect(() => {
    if (!ready.current || !userDirty.current) return;
    userDirty.current = false;
    saveSettings({
      input_device_id: inputId,
      output_device_id: outputId,
      sample_rate: sampleRate,
      buffer_frames: bufferFrames,
    }).catch((e) => setError(`Couldn't save audio settings - ${e}`));
  }, [inputId, outputId, sampleRate, bufferFrames]);

  // (Re)open the input (metering) whenever the stream parameters change.
  useEffect(() => {
    if (!inputId || !sampleRate) {
      setLevels([]);
      return;
    }
    let cancelled = false;
    const channels = deviceChannels(selectedInput);
    openInput(
      inputId,
      { sample_rate: sampleRate, channels, buffer_frames: bufferFrames },
      (u) => {
        if (cancelled) return;
        setLevels(u.channels);
        if (recordingRef.current) {
          const buckets = recWave.current.buckets;
          buckets.push({
            t: (performance.now() - recWave.current.start) / 1000,
            min: u.wave_min,
            max: u.wave_max,
          });
          // Long takes (an hour off a modular synth) must not grow this without
          // bound: the live overlay iterates every bucket per animation frame.
          // Past the cap, merge adjacent pairs — the take keeps its full span at
          // half the bucket resolution, amortized O(1) per append.
          if (buckets.length > 8000) {
            const merged: typeof buckets = [];
            for (let i = 0; i < buckets.length; i += 2) {
              const a = buckets[i];
              const b = buckets[i + 1];
              merged.push(
                b
                  ? {
                      t: a.t,
                      min: Math.min(a.min, b.min),
                      max: Math.max(a.max, b.max),
                    }
                  : a,
              );
            }
            recWave.current.buckets = merged;
          }
        }
      },
    )
      .then(() => {
        if (!cancelled) setError(null); // clear any stale error once metering runs
        // A moment later (once callbacks have fired) read the actual buffer size —
        // this is what "Default" resolved to.
        setResolvedBuffer(null);
        setTimeout(() => {
          if (!cancelled)
            inputBufferFrames()
              .then((b) => !cancelled && setResolvedBuffer(b))
              .catch(() => {});
        }, 400);
      })
      .catch((e) => {
        if (!cancelled) setError(`Couldn't open the input device - ${e}`);
      });
    return () => {
      cancelled = true;
      setLevels([]);
      // Reopening the input (device/param change or Refresh) tears down the session.
      // Reset recording state so the meter callback stops appending live-wave buckets
      // with a stale time baseline and the UI doesn't get stuck "recording".
      recordingRef.current = false;
      setRecording(false);
      closeInput().catch(() => {});
    };
  }, [inputId, sampleRate, bufferFrames, selectedInput]);

  const refresh = useCallback(async () => {
    try {
      const devs = await listDevices();
      setDevices(devs);
      setError(null);
      // Re-resolve using the current selection as "saved" preferences (fallback,
      // so it must NOT mark the state user-dirty).
      resolveSelection(devs, {
        input_device_id: inputId,
        output_device_id: outputId,
        sample_rate: sampleRate,
        buffer_frames: bufferFrames,
      });
    } catch (e) {
      setError(`Couldn't refresh devices - ${e}`);
    }
  }, [inputId, outputId, sampleRate, bufferFrames, resolveSelection]);

  const selectInput = useCallback(
    (id: string) => {
      userDirty.current = true;
      setNotice(null);
      setError(null);
      setInputId(id);
      const dev = devices.find((d) => d.id === id);
      setSampleRate((r) => defaultRate(dev, r));
    },
    [devices],
  );

  const selectOutput = useCallback((id: string) => {
    userDirty.current = true;
    setNotice(null);
    setOutputId(id);
  }, []);

  const selectRate = useCallback((rate: number) => {
    userDirty.current = true;
    setSampleRate(rate);
  }, []);

  const selectBuffer = useCallback((frames: number | null) => {
    userDirty.current = true;
    setBufferFrames(frames);
  }, []);

  // Recording elapsed-time ticker while recording.
  useEffect(() => {
    if (!recording) {
      setRecElapsed(0);
      return;
    }
    const started = performance.now();
    const id = setInterval(
      () => setRecElapsed((performance.now() - started) / 1000),
      100,
    );
    return () => clearInterval(id);
  }, [recording]);

  const startRec = useCallback(async () => {
    try {
      setError(null);
      await startRecording();
      // Baseline the live waveform to when capture actually began (after the IPC), so
      // the drawn buckets line up with the committed take instead of including pre-roll.
      recWave.current = { start: performance.now(), buckets: [] };
      recordingRef.current = true;
      setRecording(true);
    } catch (e) {
      recordingRef.current = false;
      setError(`Couldn't start recording - ${e}`);
    }
  }, []);

  const stopRec = useCallback(async () => {
    recordingRef.current = false;
    try {
      const take = await stopRecording();
      setTakes((t) => [take, ...t]);
    } catch (e) {
      setError(`Couldn't finish the take - ${e}`);
    } finally {
      setRecording(false);
    }
  }, []);

  return {
    inputs,
    outputs,
    inputId,
    outputId,
    sampleRate,
    bufferFrames,
    resolvedBuffer,
    levels,
    notice,
    error,
    recording,
    recElapsed,
    recWave,
    takes,
    canRecord: !!inputId && !!sampleRate,
    selectInput,
    selectOutput,
    selectRate,
    selectBuffer,
    refresh,
    startRec,
    stopRec,
    clearError: useCallback(() => setError(null), []),
    clearNotice: useCallback(() => setNotice(null), []),
  };
}
