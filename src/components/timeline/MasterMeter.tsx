import { useEffect, useRef, useState } from "react";
import { playbackLevels } from "../../audio/project";

const MIN_DB = -60;

function toDb(linear: number): number {
  return linear <= 0 ? MIN_DB : Math.max(MIN_DB, 20 * Math.log10(linear));
}

function pct(db: number): number {
  return ((Math.max(MIN_DB, Math.min(0, db)) - MIN_DB) / -MIN_DB) * 100;
}

/** Stereo master output meter beside the transport (W-12.3): polls the engine's
 *  reset-on-read output peaks while playing; clip latch resets on click. */
export function MasterMeter({ playing }: { playing: boolean }) {
  const [db, setDb] = useState<[number, number]>([MIN_DB, MIN_DB]);
  const [clipped, setClipped] = useState(false);
  const decay = useRef<[number, number]>([MIN_DB, MIN_DB]);

  useEffect(() => {
    if (!playing) {
      decay.current = [MIN_DB, MIN_DB];
      setDb([MIN_DB, MIN_DB]);
      return;
    }
    let alive = true;
    const id = setInterval(async () => {
      try {
        const lv = await playbackLevels();
        if (!alive) return;
        const fresh: [number, number] = [
          toDb(lv[0] ?? 0),
          toDb(lv[1] ?? lv[0] ?? 0),
        ];
        // Fast attack, ~20 dB/s release so short peaks stay readable.
        decay.current = [
          Math.max(fresh[0], decay.current[0] - 2),
          Math.max(fresh[1], decay.current[1] - 2),
        ];
        if (fresh[0] >= -0.1 || fresh[1] >= -0.1) setClipped(true);
        setDb([...decay.current] as [number, number]);
      } catch {
        /* backend gone mid-poll — next tick recovers */
      }
    }, 100);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [playing]);

  return (
    <div
      className="master-meter"
      role="group"
      aria-label="Master output level"
      title="Master output — click to reset clip hold"
      onClick={() => setClipped(false)}
    >
      <span className="mm-label" aria-hidden="true">
        OUT
      </span>
      <div className="mm-bars">
        {[0, 1].map((ch) => (
          <div className="mm-track" key={ch}>
            <div className="mm-fill" style={{ width: `${pct(db[ch])}%` }} />
          </div>
        ))}
      </div>
      <span
        className={`mm-clip${clipped ? " on" : ""}`}
        title={clipped ? "Clipped — click to reset" : "No clipping"}
      />
    </div>
  );
}
