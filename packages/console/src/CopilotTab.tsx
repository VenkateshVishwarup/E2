import { useState } from "react";
import { ViewRenderer, type View } from "./ViewRenderer.js";

interface SpecChange { path: string; kind: string; before?: unknown; after?: unknown }
interface SpecWarning { code: string; message: string }

interface ProposedDiff {
  fromVersion: number;
  toVersion: number;
  rationale: string;
  yaml: string;
  changes: SpecChange[];
  warnings: SpecWarning[];
}

interface Answer {
  text: string;
  view?: View;
  diff?: ProposedDiff;
  usedTools: string[];
  offline: boolean;
}

const SUGGESTED = [
  "Why is my needs_financing cohort converting worse?",
  "What is my cost per conversion?",
  "What should I change about this journey?",
];

export function CopilotTab({ journey }: { journey: string }) {
  const [question, setQuestion] = useState(SUGGESTED[0]!);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showYaml, setShowYaml] = useState(false);

  const ask = async (q: string) => {
    setBusy(true); setError(null); setAnswer(null); setShowYaml(false);
    try {
      const r = await fetch("/api/copilot/ask", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ journey, question: q }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      setAnswer(await r.json());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <p className="muted">
        The copilot reads through the same folds these screens read, so it cannot report a
        number the ROI tab disagrees with. It can propose a spec change; it cannot publish one.
      </p>

      <div className="ask">
        <input
          className="ask-input" value={question} disabled={busy}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && question.trim()) void ask(question); }}
          aria-label="Ask the copilot"
        />
        <button className="btn" disabled={busy || !question.trim()} onClick={() => void ask(question)}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </div>

      <div className="chips">
        {SUGGESTED.map((s) => (
          <button key={s} className="chip" disabled={busy}
                  onClick={() => { setQuestion(s); void ask(s); }}>
            {s}
          </button>
        ))}
      </div>

      {error && <p className="err">Copilot failed: {error}</p>}

      {answer && (
        <>
          <p className="answer">{answer.text}</p>
          <p className="muted provenance">
            {answer.offline
              ? "Answered without a model — keyword routing over the real read models. "
              : "Answered by the model. "}
            Read from: {answer.usedTools.join(", ") || "nothing"}
          </p>

          {answer.view && <ViewRenderer view={answer.view} />}

          {answer.diff && (
            <div className="band modelled">
              <h3>Proposed — v{answer.diff.fromVersion} → v{answer.diff.toVersion}</h3>
              <p>{answer.diff.rationale}</p>
              <table>
                <thead><tr><th>path</th><th>before</th><th>after</th></tr></thead>
                <tbody>
                  {answer.diff.changes.map((c) => (
                    <tr key={c.path}>
                      <td><code>{c.path}</code></td>
                      <td><code>{JSON.stringify(c.before) ?? "—"}</code></td>
                      <td><code>{JSON.stringify(c.after) ?? "—"}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Lint warnings travel with the proposal. A warning hidden here
                  is a warning nobody acts on. */}
              {answer.diff.warnings.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {answer.diff.warnings.map((w) => (
                    <div className="alert warn" key={w.code}>{w.message}</div>
                  ))}
                </div>
              )}

              <p className="muted" style={{ marginTop: 12 }}>
                Already parsed, linted and diffed — it would publish as it stands. Nothing has
                been published.
              </p>
              <button className="btn" onClick={() => setShowYaml(!showYaml)}>
                {showYaml ? "Hide" : "Show"} proposed spec
              </button>
              {showYaml && <pre className="yaml">{answer.diff.yaml}</pre>}
            </div>
          )}
        </>
      )}
    </>
  );
}
