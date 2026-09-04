import { useState } from "react";
import "./styles.css";
import { ReplayComparison } from "./ReplayComparison.js";
import { SimulateRun } from "./SimulateRun.js";
import { Scoreboard } from "./Scoreboard.js";

const JOURNEY = "mba-admissions-qualification";
const TABS = ["Replay", "Simulate", "A/B"] as const;

export function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Replay");

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

      {tab === "Replay" && <ReplayComparison journey={JOURNEY} a={3} b={4} />}
      {tab === "Simulate" && <SimulateRun journey={JOURNEY} version={4} />}
      {tab === "A/B" && <Scoreboard journey={JOURNEY} a={4} b={5} />}
    </main>
  );
}
