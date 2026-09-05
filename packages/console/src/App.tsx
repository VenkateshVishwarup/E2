import { useState } from "react";
import "./styles.css";
import { ReplayComparison } from "./ReplayComparison.js";
import { SimulateRun } from "./SimulateRun.js";
import { Scoreboard } from "./Scoreboard.js";
import { Roi } from "./Roi.js";
import { CopilotTab } from "./CopilotTab.js";
import { ChatTab } from "./ChatTab.js";
import { JourneyEditor } from "./JourneyEditor.js";

const JOURNEY = "mba-admissions-qualification";
const TABS = ["Journey", "Chat", "Replay", "Simulate", "A/B", "ROI", "Copilot"] as const;

export function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Journey");
  // Publishing changes what every other tab is looking at, so they remount.
  const [published, setPublished] = useState(0);

  return (
    <main className="wrap">
      <h1>Mid-Funnel Console</h1>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} className="tab" role="tab"
                  aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "Journey" && (
        <JourneyEditor journey={JOURNEY} onPublished={() => setPublished((n) => n + 1)} />
      )}
      {tab === "Chat" && <ChatTab key={published} journey={JOURNEY} />}
      {tab === "Replay" && <ReplayComparison journey={JOURNEY} a={3} b={4} />}
      {tab === "Simulate" && <SimulateRun journey={JOURNEY} version={4} />}
      {tab === "A/B" && <Scoreboard journey={JOURNEY} a={4} b={5} />}
      {tab === "ROI" && <Roi journey={JOURNEY} />}
      {tab === "Copilot" && <CopilotTab journey={JOURNEY} />}
    </main>
  );
}
