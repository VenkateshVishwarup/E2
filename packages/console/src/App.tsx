import { useState } from "react";
import "./styles.css";
import { Overview } from "./Overview.js";
import { JourneyEditor } from "./JourneyEditor.js";
import { ChatTab } from "./ChatTab.js";
import { SimulateRun } from "./SimulateRun.js";
import { Scoreboard } from "./Scoreboard.js";
import { ReplayComparison } from "./ReplayComparison.js";
import { Roi } from "./Roi.js";
import { Insights } from "./Insights.js";
import { CopilotTab } from "./CopilotTab.js";
import { useVersions } from "./useVersions.js";
import { Roadmap } from "./Roadmap.js";
import { item } from "./roadmap-data.js";

const JOURNEY = "mba-admissions-qualification";

/**
 * Three sections, in the order the work actually happens: build the agent, prove
 * it before it meets real traffic, then read what it did.
 *
 * The middle section is labelled for what it is. Simulation, A/B and replay are
 * a builder's instruments — they answer "is this version safe to ship?" — and
 * mixing them into one flat list with the screens a marketer lives on made
 * every screen look equally central.
 */
const SECTIONS = [
  {
    name: "Build",
    caption: "Author the contract and try it yourself",
    tabs: ["Journey", "Chat"],
  },
  {
    name: "Prove",
    caption: "Before a version meets real traffic",
    tabs: ["Simulate", "Compare", "Replay"],
  },
  {
    name: "Measure",
    caption: "What actually happened",
    tabs: ["Overview", "Insights", "ROI", "Copilot"],
  },
  {
    name: "Roadmap",
    caption: "What this does not do yet",
    tabs: ["Roadmap"],
  },
] as const;

type Tab = (typeof SECTIONS)[number]["tabs"][number];

export function App() {
  // Overview is the landing screen: a returning user wants status, and it routes
  // you to the next action when there is nothing to show yet.
  const [tab, setTab] = useState<Tab>("Overview");
  const [published, setPublished] = useState(0);
  const versions = useVersions(JOURNEY, published);

  const section = SECTIONS.find((s) => (s.tabs as readonly string[]).includes(tab))!;

  return (
    <main className="wrap">
      <header className="masthead">
        <h1>Mid-Funnel Console</h1>
        {/* One journey today. The registry is keyed by journey already; the
            selector is what is missing, so it is shown rather than implied. */}
        <select className="journey-select" value={JOURNEY} disabled
                title={item("journeys").will} aria-label="Journey">
          <option value={JOURNEY}>{JOURNEY}</option>
        </select>
        <span className="soon-tag" title={item("journeys").will}>
          more journeys soon
        </span>
      </header>

      <nav className="sections" aria-label="Sections">
        {SECTIONS.map((s) => (
          <button key={s.name} className="section"
                  aria-selected={s.name === section.name}
                  onClick={() => setTab(s.tabs[0] as Tab)}>
            {s.name}
          </button>
        ))}
      </nav>

      <div className="tabs" role="tablist">
        {section.tabs.map((t) => (
          <button key={t} className="tab" role="tab"
                  aria-selected={tab === t} onClick={() => setTab(t as Tab)}>
            {t}
          </button>
        ))}
        <span className="section-caption muted">{section.caption}</span>
      </div>

      {tab === "Overview" && (
        <Overview journey={JOURNEY} versions={versions} onGo={(t) => setTab(t as Tab)} />
      )}
      {tab === "Journey" && (
        <JourneyEditor journey={JOURNEY} onPublished={() => setPublished((n) => n + 1)} />
      )}
      {tab === "Chat" && <ChatTab key={published} journey={JOURNEY} />}
      {tab === "Simulate" && <SimulateRun journey={JOURNEY} versions={versions} />}
      {tab === "Compare" && <Scoreboard journey={JOURNEY} versions={versions} />}
      {tab === "Replay" && <ReplayComparison journey={JOURNEY} versions={versions} />}
      {tab === "Insights" && <Insights journey={JOURNEY} />}
      {tab === "ROI" && <Roi journey={JOURNEY} />}
      {tab === "Copilot" && <CopilotTab journey={JOURNEY} />}
      {tab === "Roadmap" && <Roadmap />}
    </main>
  );
}
