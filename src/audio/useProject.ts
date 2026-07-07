import { useCallback, useEffect, useState } from "react";
import * as api from "./project";
import type { ProjectView } from "./project";

export function useProject() {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Unsaved-changes flag: any edit sets it; save/open/new clear it (F1/F32).
  const [dirty, setDirty] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProject(await api.getProject());
    } catch (e) {
      setError(`Couldn't load the project - ${e}`);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = useCallback(
    async (p: Promise<ProjectView>): Promise<ProjectView | null> => {
      try {
        const view = await p;
        setProject(view);
        setDirty(true);
        setError(null);
        return view; // callers can locate what the edit created (W-08/W-09)
      } catch (e) {
        setError(`Edit failed - ${e}`);
        return null;
      }
    },
    [],
  );

  return {
    project,
    error,
    clearError: useCallback(() => setError(null), []),
    refresh,
    dirty,
    markDirty: useCallback(() => setDirty(true), []),
    markClean: useCallback(() => setDirty(false), []),
    split: (id: string, frame: number) => run(api.splitClip(id, frame)),
    trimEnd: (id: string, frame: number) => run(api.trimClipEnd(id, frame)),
    trimStart: (id: string, frame: number) => run(api.trimClipStart(id, frame)),
    move: (id: string, track: string, frame: number) =>
      run(api.moveClip(id, track, frame)),
    del: (id: string, ripple: boolean) => run(api.deleteClip(id, ripple)),
    deleteRange: (start: number, end: number, ripple: boolean) =>
      run(api.deleteRange(start, end, ripple)),
    splitChannels: (id: string) => run(api.splitClipChannels(id)),
    setClipGain: (id: string, g: number) => run(api.setClipGain(id, g)),
    setTrackGain: (id: string, g: number) => run(api.setTrackGain(id, g)),
    setTrackMuted: (id: string, m: boolean) => run(api.setTrackMuted(id, m)),
    setTrackSoloed: (id: string, s: boolean) => run(api.setTrackSoloed(id, s)),
    setTrackName: (id: string, n: string) => run(api.setTrackName(id, n)),
    setTrackColor: (id: string, c: string | null) =>
      run(api.setTrackColor(id, c)),
    addTrack: () => run(api.addTrack()),
    removeTrack: (id: string) => run(api.removeTrack(id)),
    duplicate: (id: string, start: number) => run(api.duplicateClip(id, start)),
    setClipName: (id: string, name: string) => run(api.setClipName(id, name)),
    paste: (spec: api.ClipSpec, trackId: string) =>
      run(api.pasteClip(spec, trackId)),
    setFadeIn: (id: string, len: number, curve: api.FadeCurve) =>
      run(api.setClipFadeIn(id, len, curve)),
    setFadeOut: (id: string, len: number, curve: api.FadeCurve) =>
      run(api.setClipFadeOut(id, len, curve)),
    undo: () => run(api.undo()),
    redo: () => run(api.redo()),
  };
}

export type ProjectApi = ReturnType<typeof useProject>;
