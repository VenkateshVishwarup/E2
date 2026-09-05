import { useEffect, useState } from "react";
import { item } from "./roadmap-data.js";

/**
 * The agent's identity, shown where the agent is worked on rather than in the
 * masthead.
 *
 * The masthead names the product; this names the thing you are editing. They
 * were the same line for a while, which made a single agent look like a global
 * setting instead of one of several you will eventually pick between.
 */
export function AgentHeader({ journey, reload }: { journey: string; reload: number }) {
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
          <select className="journey-select" value={journey} disabled
                  title={item("journeys").will} aria-label="Agent">
            <option value={journey}>{journey}</option>
          </select>
          <span className="soon-tag" title={item("journeys").will}>more agents soon</span>
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
