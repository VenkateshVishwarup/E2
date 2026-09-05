import { useEffect, useState } from "react";
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
import { Unlock } from "./Unlock.js";
import { LOCKED } from "./auth.js";

const JOURNEY = "mba-admissions-qualification";

/**
 * Ordered by where people land and where they stay, not by the lifecycle they
 * traverse once. Performance is first because it is the default view and the
 * daily one; Agent is where you change things; Experiments is a builder's
 * bench, kept separate so it stops competing for attention with the screens a
 * marketer lives on.
 *
 * All four names are nouns for what the section contains, rather than verbs for
 * what you are meant to do there — "Prove" and "Measure" read as instructions,
 * and a nav label should say where you are.
 */
const SECTIONS = [
  {
    name: "Performance",
    caption: "What your agent is actually doing",
    tabs: ["Overview", "Findings", "ROI", "Copilot"],
  },
  {
    name: "Agent",
    caption: "Define it, and talk to it",
    tabs: ["Journey", "Chat"],
  },
  {
    name: "Experiments",
    caption: "Try a change before it meets real traffic",
    tabs: ["Simulate", "Compare", "Replay"],
  },
  {
    name: "Roadmap",
    caption: "What Elevate does not do yet, and what already underpins it",
    tabs: ["Roadmap"],
  },
] as const;

type Tab = (typeof SECTIONS)[number]["tabs"][number];

export function App() {
  // Overview is the landing screen: a returning user wants status, and it routes
  // you to the next action when there is nothing to show yet.
  const [tab, setTab] = useState<Tab>("Overview");
  const [published, setPublished] = useState(0);
  const [locked, setLocked] = useState(false);
  const versions = useVersions(JOURNEY, published);

  // Any 401 anywhere puts the whole console behind the token prompt, rather
  // than leaving one screen broken and the rest looking fine.
  useEffect(() => {
    const onLocked = () => setLocked(true);
    window.addEventListener(LOCKED, onLocked);
    return () => window.removeEventListener(LOCKED, onLocked);
  }, []);

  const section = SECTIONS.find((s) => (s.tabs as readonly string[]).includes(tab))!;

  return (
    <main className="wrap">
      <header className="masthead">
        <h1>Elevate</h1>
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
        {section.tabs.length > 1 && section.tabs.map((t) => (
          <button key={t} className="tab" role="tab"
                  aria-selected={tab === t} onClick={() => setTab(t as Tab)}>
            {t}
          </button>
        ))}
        <span className="section-caption muted">{section.caption}</span>
      </div>

      {locked && <Unlock onUnlocked={() => { setLocked(false); setPublished((n) => n + 1); }} />}

      {!locked && tab === "Overview" && (
        <Overview journey={JOURNEY} versions={versions} onGo={(t) => setTab(t as Tab)} />
      )}
      {!locked && tab === "Journey" && (
        <JourneyEditor journey={JOURNEY} onPublished={() => setPublished((n) => n + 1)} />
      )}
      {!locked && tab === "Chat" && <ChatTab key={published} journey={JOURNEY} />}
      {!locked && tab === "Simulate" && <SimulateRun journey={JOURNEY} versions={versions} />}
      {!locked && tab === "Compare" && <Scoreboard journey={JOURNEY} versions={versions} />}
      {!locked && tab === "Replay" && <ReplayComparison journey={JOURNEY} versions={versions} />}
      {!locked && tab === "Findings" && <Insights journey={JOURNEY} />}
      {!locked && tab === "ROI" && <Roi journey={JOURNEY} />}
      {!locked && tab === "Copilot" && <CopilotTab journey={JOURNEY} />}
      {!locked && tab === "Roadmap" && <Roadmap />}
    </main>
  );
}
