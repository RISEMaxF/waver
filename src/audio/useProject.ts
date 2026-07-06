import { useCallback, useEffect, useState } from "react";
import * as api from "./project";
import type { ProjectView } from "./project";

export function useProject() {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProject(await api.getProject());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = useCallback(async (p: Promise<ProjectView>) => {
    try {
      setProject(await p);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return {
    project,
    error,
    refresh,
    split: (id: string, frame: number) => run(api.splitClip(id, frame)),
    trimEnd: (id: string, frame: number) => run(api.trimClipEnd(id, frame)),
    trimStart: (id: string, frame: number) => run(api.trimClipStart(id, frame)),
    move: (id: string, track: string, frame: number) =>
      run(api.moveClip(id, track, frame)),
    del: (id: string, ripple: boolean) => run(api.deleteClip(id, ripple)),
    splitChannels: (id: string) => run(api.splitClipChannels(id)),
    setClipGain: (id: string, g: number) => run(api.setClipGain(id, g)),
    setTrackGain: (id: string, g: number) => run(api.setTrackGain(id, g)),
    setTrackMuted: (id: string, m: boolean) => run(api.setTrackMuted(id, m)),
    setTrackSoloed: (id: string, s: boolean) => run(api.setTrackSoloed(id, s)),
    setFadeIn: (id: string, len: number, curve: api.FadeCurve) =>
      run(api.setClipFadeIn(id, len, curve)),
    setFadeOut: (id: string, len: number, curve: api.FadeCurve) =>
      run(api.setClipFadeOut(id, len, curve)),
    undo: () => run(api.undo()),
    redo: () => run(api.redo()),
  };
}

export type ProjectApi = ReturnType<typeof useProject>;
