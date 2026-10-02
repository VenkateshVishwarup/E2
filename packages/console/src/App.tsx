import { useEffect, useRef, useState } from "react";
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
import { useJourneys, useVersions } from "./useVersions.js";
import { Roadmap } from "./Roadmap.js";
import { Architecture } from "./Architecture.js";
import { Knowledge } from "./Knowledge.js";
import { AgentHeader } from "./AgentHeader.js";
import { Unlock } from "./Unlock.js";
import { LOCKED } from "./auth.js";

/** The reference journey, used until the list says what exists. */
const DEFAULT_JOURNEY = "mba-admissions-qualification";
const REMEMBERED = "e2.journey";

/** Which journey this browser last looked at. A convenience, so failure is fine. */
function remembered(): string | null {
  try { return localStorage.getItem(REMEMBERED); } catch { return null; }
}
function remember(journey: string): void {
  try { localStorage.setItem(REMEMBERED, journey); } catch { /* not persisted */ }
}

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
    caption: "What E2 does not do yet, and what already underpins it",
    tabs: ["Roadmap", "Architecture", "Knowledge"],
  },
] as const;

type Tab = (typeof SECTIONS)[number]["tabs"][number];

export function App() {
  // Overview is the landing screen: a returning user wants status, and it routes
  // you to the next action when there is nothing to show yet.
  const [tab, setTab] = useState<Tab>("Overview");
  const [published, setPublished] = useState(0);
  const [locked, setLocked] = useState(false);
  const [journey, setJourney] = useState(() => remembered() ?? DEFAULT_JOURNEY);
  const journeys = useJourneys(published);
  const versions = useVersions(journey, published);
  /** A message for the editor after it remounts on a journey it just created. */
  const [flash, setFlash] = useState<string | null>(null);

  const switchTo = (next: string) => {
    setJourney(next);
    remember(next);
    setFlash(null);
  };

  // A remembered journey can be gone — another browser, another database. Check
  // once, against the first list, and fall back to one that exists. Only once:
  // a journey published a moment ago is newer than any list in flight.
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current || !journeys || journeys.length === 0) return;
    checked.current = true;
    if (!journeys.some((j) => j.journey === journey)) switchTo(journeys[0]!.journey);
  }, [journeys]);

  const onPublished = (name: string, message: string) => {
    setPublished((n) => n + 1);
    if (name !== journey) {
      switchTo(name);
      setFlash(message);
    } else {
      setFlash(null);
    }
  };

  // A flash confirms the act that brought the editor here. Once the editor has
  // been left it is history, and showing it again on return would read as new.
  useEffect(() => { if (tab !== "Journey") setFlash(null); }, [tab]);

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
      {/* The masthead names the product. The agent is named in the section
          where it is worked on. */}
      <header className="masthead">
        <h1>E2</h1>
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

      {section.name !== "Roadmap" && !locked && (
        <AgentHeader journey={journey} journeys={journeys} onSwitch={switchTo} reload={published} />
      )}

      <div className="tabs" role="tablist">
        {section.tabs.length > 1 && section.tabs.map((t) => (
          <button key={t} className="tab" role="tab"
                  aria-selected={tab === t} onClick={() => setTab(t as Tab)}>
            {t}
          </button>
        ))}
        <span className="section-caption muted">{section.caption}</span>
      </div>

      {locked && <Unlock />}

      {/* Keyed by journey: switching remounts every screen, so nothing one
          journey fetched or half-finished can be shown under another's name. */}
      {!locked && (
        <div key={journey}>
          {tab === "Overview" && (
            <Overview journey={journey} onGo={(t) => setTab(t as Tab)} />
          )}
          {tab === "Journey" && (
            <JourneyEditor journey={journey} journeys={journeys?.map((j) => j.journey) ?? []}
                           flash={flash} onPublished={onPublished} />
          )}
          {tab === "Chat" && <ChatTab key={published} journey={journey} />}
          {tab === "Simulate" && <SimulateRun journey={journey} versions={versions} />}
          {tab === "Compare" && <Scoreboard journey={journey} versions={versions} />}
          {tab === "Replay" && <ReplayComparison journey={journey} versions={versions} />}
          {tab === "Findings" && <Insights journey={journey} />}
          {tab === "ROI" && <Roi journey={journey} />}
          {tab === "Copilot" && <CopilotTab journey={journey} />}
          {tab === "Roadmap" && <Roadmap />}
          {tab === "Architecture" && <Architecture />}
          {tab === "Knowledge" && <Knowledge />}
        </div>
      )}
    </main>
  );
}
