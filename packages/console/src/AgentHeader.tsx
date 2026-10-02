import { useEffect, useState } from "react";
import type { JourneySummary } from "./useVersions.js";

/**
 * Which journey you are looking at, and the switch between them.
 *
 * The masthead names the product; this names the thing on screen. They were
 * the same line for a while, which made a single agent look like a global
 * setting instead of one of several you pick between. It sits above every
 * section whose screens are scoped to one journey, because a Findings or ROI
 * screen that does not say whose numbers it shows is the same mistake.
 */
export function AgentHeader({ journey, journeys, onSwitch, reload }: {
  journey: string;
  journeys: JourneySummary[] | null;
  onSwitch: (journey: string) => void;
  reload: number;
}) {
  const [live, setLive] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [persona, setPersona] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const j = encodeURIComponent(journey);
      const [l, v] = await Promise.all([
        fetch(`/api/journeys/${j}/live`), fetch(`/api/journeys/${j}/versions`),
      ]);
      const liveVersion = l.ok ? ((await l.json()).version as number) : null;
      setLive(liveVersion);
      if (v.ok) setCount(((await v.json()).versions as number[]).length);

      // The persona and identity live in the spec, so they are read from it
      // rather than restated here and left to drift.
      if (liveVersion !== null) {
        const s = await fetch(`/api/journeys/${j}/source?version=${liveVersion}`);
        if (s.ok) {
          const yaml = (await s.json()).yaml as string;
          setPersona(/^\s*persona:\s*(\S+)/m.exec(yaml)?.[1] ?? null);
        }
      }
    })();
  }, [journey, reload]);

  return (
    <header className="agent-header">
      <div>
        <div className="agent-name">
          {/* The current journey is always an option, even before the list
              arrives, so the control never renders blank. */}
          <select className="journey-select" value={journey} aria-label="Journey"
                  disabled={!journeys || journeys.length < 2}
                  onChange={(e) => onSwitch(e.target.value)}>
            {(journeys?.some((j) => j.journey === journey)
              ? journeys
              : [{ journey }, ...(journeys ?? [])]
            ).map((j) => <option key={j.journey} value={j.journey}>{j.journey}</option>)}
          </select>
          {journeys && journeys.length > 1 && (
            <span className="muted provenance">{journeys.length} journeys</span>
          )}
        </div>
        <p className="muted agent-meta">
          {persona && <><code>{persona}</code> · </>}
          {live !== null ? <>v{live} live</> : <>not live</>}
          {count !== null && <> · {count} version{count === 1 ? "" : "s"} published</>}
        </p>
      </div>
    </header>
  );
}
