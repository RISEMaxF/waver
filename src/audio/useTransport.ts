import { useCallback, useEffect, useRef, useState } from "react";
import { pausePlayback, play, playbackStatus, stopPlayback } from "./project";

/** Encapsulates playback transport state (FR-6.1/6.2): play/pause/stop and a poll
 *  loop that reports the audible position back via `onPosition`. */
export function useTransport(opts: {
  outputId: string | null;
  hasContent: boolean;
  startFrame: number;
  sr: number;
  onPosition: (sec: number) => void;
}) {
  const { outputId, hasContent, startFrame, sr, onPosition } = opts;
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  // Where the current playback began, captured at play() time (startFrame moves with
  // the playhead during playback, so it can't be read back at end).
  const playStartFrame = useRef(0);

  const startPlay = useCallback(() => {
    if (!outputId || !hasContent) return;
    playStartFrame.current = startFrame;
    play(outputId, startFrame)
      .then(() => {
        setPlaying(true);
        setPaused(false);
      })
      .catch(() => {});
  }, [outputId, hasContent, startFrame]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      const next = !p;
      pausePlayback(next).catch(() => {});
      return next;
    });
  }, []);

  const stopPlay = useCallback(() => {
    stopPlayback().catch(() => {});
    setPlaying(false);
    setPaused(false);
  }, []);

  // Poll the transport while playing; the playhead follows the audible output.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let alive = true;
    const poll = async () => {
      try {
        const st = await playbackStatus();
        if (!alive) return;
        if (!st.playing) {
          // Playback ended: return the playhead to where it started so pressing play
          // again replays the same section (instead of starting from the end = silence).
          setPlaying(false);
          setPaused(false);
          onPosition(playStartFrame.current / sr);
          return;
        }
        onPosition(st.position_frames / sr);
      } catch {
        /* ignore */
      }
      if (alive) raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [playing, sr, onPosition]);

  return { playing, paused, startPlay, togglePause, stopPlay };
}
