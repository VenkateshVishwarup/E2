import { useState } from "react";

/**
 * C4 at two levels, hand-drawn as SVG rather than rendered from Mermaid.
 *
 * A diagram library would add roughly a megabyte to a 58 KB bundle to lay out
 * fourteen boxes that never move. These use the same CSS custom properties as
 * everything else, so they follow the theme instead of fighting it.
 */
const LEVELS = ["Context", "Containers", "Data flow"] as const;
type Level = (typeof LEVELS)[number];

export function Architecture() {
  const [level, setLevel] = useState<Level>("Context");

  return (
    <>
      <p className="muted">
        C4, at the two levels that carry information. Level 3 would be a component diagram
        per container; the <a href="#okf">knowledge file</a> below does that job in prose,
        where the reasoning fits.
      </p>

      <div className="pickers">
        {LEVELS.map((l) => (
          <button key={l} className="tab" aria-selected={level === l}
                  onClick={() => setLevel(l)}>{l}</button>
        ))}
      </div>

      <div className="scroll diagram">
        {level === "Context" && <ContextDiagram />}
        {level === "Containers" && <ContainerDiagram />}
        {level === "Data flow" && <FlowDiagram />}
      </div>

      <p className="muted">{CAPTIONS[level]}</p>
    </>
  );
}

const CAPTIONS: Record<Level, string> = {
  Context: "Who and what E2 touches. The lead never sees a person unless the journey " +
           "decides one is needed, and the marketer never edits a prompt.",
  Containers: "One deployable artifact, five packages, one database. `core` depends on " +
              "nothing; `batch` and `intelligence` are peers and neither depends on the " +
              "other. That is what lets a team split along these lines.",
  "Data flow": "Every screen is a fold over one table. This is the whole reason two " +
               "screens cannot disagree about a number — there is nothing else to read.",
};

/* ── Level 1 · System context ─────────────────────────────────────────────── */
function ContextDiagram() {
  return (
    <svg viewBox="0 0 720 380" className="c4" role="img"
         aria-label="System context: leads, marketers and counsellors around E2">
      <Defs />
      <Person x={40} y={30} label="Lead" note="Answers over chat" />
      <Person x={40} y={230} label="Marketer" note="Declares the journey" />
      <Person x={540} y={230} label="Counsellor" note="Takes the handoff" />

      <Box x={250} y={120} w={220} h={110} kind="system"
           title="E2" lines={["Qualifies and nurtures", "mid-funnel leads"]} />

      <Ext x={540} y={30} label="Model provider" note="OpenAI" />
      <Ext x={250} y={300} label="CRM · Calendar" note="via the Tool Broker" />

      <Arrow from={[190, 75]} to={[250, 150]} label="converses" />
      <Arrow from={[190, 262]} to={[250, 200]} label="authors, reads" />
      <Arrow from={[470, 175]} to={[540, 262]} label="hands off" />
      <Arrow from={[470, 150]} to={[540, 78]} label="reasons with" />
      <Arrow from={[360, 230]} to={[360, 300]} label="acts on" />
    </svg>
  );
}

/* ── Level 2 · Containers ─────────────────────────────────────────────────── */
function ContainerDiagram() {
  return (
    <svg viewBox="0 0 760 470" className="c4" role="img"
         aria-label="Containers: console, API, four packages and one database">
      <Defs />
      <Box x={30} y={20} w={190} h={70} kind="ui"
           title="console" lines={["React · static bundle"]} />
      <Box x={280} y={20} w={200} h={70} kind="api"
           title="web" lines={["Fastify · chat · routes"]} />
      <Ext x={560} y={20} label="Model provider" note="one client interface" />

      <Box x={30} y={150} w={190} h={80} kind="pkg"
           title="batch" lines={["replay · simulate", "eval · allocator"]} />
      <Box x={280} y={150} w={200} h={80} kind="pkg"
           title="intelligence" lines={["attribution · findings", "copilot"]} />
      <Box x={530} y={150} w={190} h={80} kind="pkg"
           title="runtime" lines={["step() · extraction", "broker · metering"]} />

      <Box x={280} y={280} w={200} h={70} kind="pkg"
           title="core" lines={["events · registry · spec", "metrics · stats"]} />
      <Box x={280} y={390} w={200} h={60} kind="db"
           title="PostgreSQL" lines={["events · journey_versions"]} />

      <Arrow from={[220, 55]} to={[280, 55]} label="/api" />
      <Arrow from={[480, 55]} to={[560, 55]} label="" />
      <Arrow from={[360, 90]} to={[200, 150]} label="" />
      <Arrow from={[380, 90]} to={[380, 150]} label="" />
      <Arrow from={[420, 90]} to={[570, 150]} label="" />
      <Arrow from={[150, 230]} to={[330, 280]} label="" />
      <Arrow from={[380, 230]} to={[380, 280]} label="" />
      <Arrow from={[600, 230]} to={[440, 280]} label="" />
      <Arrow from={[380, 350]} to={[380, 390]} label="reads · appends" />
    </svg>
  );
}

/* ── Data flow ────────────────────────────────────────────────────────────── */
function FlowDiagram() {
  return (
    <svg viewBox="0 0 760 340" className="c4" role="img"
         aria-label="Every read model is a fold over one event table">
      <Defs />
      <Box x={40} y={20} w={150} h={56} kind="ui" title="Chat" lines={["a real lead"]} />
      <Box x={40} y={100} w={150} h={56} kind="ui" title="Simulate" lines={["a persona"]} />
      <Box x={40} y={180} w={150} h={56} kind="ui" title="Import" lines={["history"]} />

      <Box x={280} y={98} w={190} h={70} kind="db"
           title="events" lines={["append-only", "env · run_id · agent_id"]} />

      <Box x={570} y={10} w={150} h={50} kind="pkg" title="Replay" lines={[]} />
      <Box x={570} y={72} w={150} h={50} kind="pkg" title="ROI" lines={[]} />
      <Box x={570} y={134} w={150} h={50} kind="pkg" title="Findings" lines={[]} />
      <Box x={570} y={196} w={150} h={50} kind="pkg" title="Compare" lines={[]} />
      <Box x={570} y={258} w={150} h={50} kind="pkg" title="Copilot" lines={[]} />

      {[48, 128, 208].map((y) => (
        <Arrow key={y} from={[190, y + 20]} to={[280, 133]} label="" />
      ))}
      {[35, 97, 159, 221, 283].map((y) => (
        <Arrow key={y} from={[470, 133]} to={[570, y]} label="" />
      ))}
      <text x={375} y={200} className="c4-note" textAnchor="middle">
        one write path
      </text>
      <text x={520} y={320} className="c4-note" textAnchor="middle">
        every read is a fold
      </text>
    </svg>
  );
}

/* ── primitives ───────────────────────────────────────────────────────────── */
function Defs() {
  return (
    <defs>
      <marker id="c4arrow" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" className="c4-arrowhead" />
      </marker>
    </defs>
  );
}

function Box({ x, y, w, h, title, lines, kind }: {
  x: number; y: number; w: number; h: number;
  title: string; lines: string[]; kind: "system" | "api" | "ui" | "pkg" | "db";
}) {
  const top = y + (lines.length === 0 ? h / 2 + 5 : 26);
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} className={`c4-box ${kind}`} />
      <text x={x + w / 2} y={top} className="c4-title" textAnchor="middle">{title}</text>
      {lines.map((l, i) => (
        <text key={l} x={x + w / 2} y={top + 18 + i * 15} className="c4-sub" textAnchor="middle">{l}</text>
      ))}
    </g>
  );
}

function Person({ x, y, label, note }: { x: number; y: number; label: string; note: string }) {
  return (
    <g>
      <circle cx={x + 75} cy={y + 20} r={13} className="c4-box ui" />
      <rect x={x} y={y + 38} width={150} height={52} rx={8} className="c4-box ui" />
      <text x={x + 75} y={y + 60} className="c4-title" textAnchor="middle">{label}</text>
      <text x={x + 75} y={y + 78} className="c4-sub" textAnchor="middle">{note}</text>
    </g>
  );
}

function Ext({ x, y, label, note }: { x: number; y: number; label: string; note: string }) {
  return (
    <g>
      <rect x={x} y={y} width={160} height={62} rx={8} className="c4-box ext" />
      <text x={x + 80} y={y + 27} className="c4-title" textAnchor="middle">{label}</text>
      <text x={x + 80} y={y + 45} className="c4-sub" textAnchor="middle">{note}</text>
    </g>
  );
}

function Arrow({ from, to, label }: { from: [number, number]; to: [number, number]; label: string }) {
  const [x1, y1] = from; const [x2, y2] = to;
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} className="c4-line" markerEnd="url(#c4arrow)" />
      {label && (
        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} className="c4-note" textAnchor="middle">
          {label}
        </text>
      )}
    </g>
  );
}
