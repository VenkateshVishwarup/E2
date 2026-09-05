import { useState } from "react";
import { OKF } from "./okf-content.js";

const TITLES: Record<string, string> = {
  index: "Overview",
  "event-spine": "Event spine",
  "journey-spec": "Journey spec",
  "version-lifecycle": "Version lifecycle",
  "metric-predicates": "Metric predicates",
  "agent-runtime": "Agent runtime",
  "evidence-extraction": "Evidence extraction",
  "tool-broker": "Tool broker",
  replay: "Counterfactual replay",
  simulation: "Simulation",
  attribution: "Attribution",
  findings: "Findings",
  copilot: "Copilot",
  "live-conversation": "Live conversation",
};

export function Knowledge() {
  const [doc, setDoc] = useState("index");
  const keys = Object.keys(OKF);

  return (
    <>
      <p className="muted">
        The operational knowledge file — what the concepts are and where each one lives, so
        a change lands in the right place. It is <code>okf/</code> in the repository; this
        renders the same files rather than a second copy.
      </p>

      <div className="pickers" style={{ flexWrap: "wrap" }}>
        {keys.map((k) => (
          <button key={k} className="tab" aria-selected={doc === k} onClick={() => setDoc(k)}>
            {TITLES[k] ?? k}
          </button>
        ))}
      </div>

      <Markdown source={OKF[doc] ?? ""} onLink={(href) => {
        const key = href.replace(/^.*\//, "").replace(/\.md$/, "");
        if (OKF[key]) setDoc(key);
      }} />
    </>
  );
}

/**
 * A deliberately small Markdown renderer.
 *
 * These documents use headings, tables, lists, fenced code, inline code, bold,
 * and links between concepts — nothing else. A parser library would be an order
 * of magnitude larger than the content it renders, and would happily render
 * raw HTML, which is exactly what should not happen to text that will later
 * come from elsewhere.
 */
function Markdown({ source, onLink }: { source: string; onLink: (href: string) => void }) {
  const blocks: React.ReactNode[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith("```")) {
      const body: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i]!);
      blocks.push(<pre className="yaml" key={blocks.length}>{body.join("\n")}</pre>);
      continue;
    }

    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        const cells = lines[i]!.split("|").slice(1, -1).map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c.replace(/[:\s]/g, "") || "-") && /^[-:\s]*$/.test(c))) {
          rows.push(cells);
        }
        i++;
      }
      i--;
      const [head, ...body] = rows;
      blocks.push(
        <div className="scroll" key={blocks.length}>
          <table>
            <thead><tr>{head?.map((c, j) => <th key={j}><Inline text={c} onLink={onLink} /></th>)}</tr></thead>
            <tbody>
              {body.map((r, j) => (
                <tr key={j}>{r.map((c, k) => <td key={k}><Inline text={c} onLink={onLink} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = <Inline text={heading[2]!} onLink={onLink} />;
      blocks.push(level <= 2
        ? <h2 key={blocks.length}>{text}</h2>
        : <h3 className="view-title" key={blocks.length}>{text}</h3>);
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*]|\d+\.)\s/, ""));
        i++;
      }
      i--;
      blocks.push(
        <ul key={blocks.length}>
          {items.map((t, j) => <li key={j}><Inline text={t} onLink={onLink} /></li>)}
        </ul>,
      );
      continue;
    }

    if (line.trim()) {
      const para: string[] = [line];
      while (i + 1 < lines.length && lines[i + 1]!.trim() &&
             !/^(\||#{1,4}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i + 1]!)) {
        para.push(lines[++i]!);
      }
      blocks.push(<p key={blocks.length}><Inline text={para.join(" ")} onLink={onLink} /></p>);
    }
  }

  return <div className="okf">{blocks}</div>;
}

/** Bold, inline code and links. Everything else is text, on purpose. */
function Inline({ text, onLink }: { text: string; onLink: (href: string) => void }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
        if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (link) {
          return (
            <button key={i} className="okf-link" onClick={() => onLink(link[2]!)}>
              {link[1]}
            </button>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
