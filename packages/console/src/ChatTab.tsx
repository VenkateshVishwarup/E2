import { useEffect, useRef, useState } from "react";
import { money } from "./format.js";
import { item } from "./roadmap-data.js";

interface EvidenceView {
  field: string; required: boolean; value: unknown;
  confidence: number | null; sensitive: boolean;
}
interface ChatState {
  leadId: string; journey: string; version: number;
  turns: Array<{ role: "agent" | "lead"; text: string; at: string }>;
  evidence: EvidenceView[]; missingRequired: string[];
  score: number | null; decision: string | null;
  metrics: Record<string, boolean | number>;
  completed: boolean; escalated: boolean; escalationRule: string | null;
  modelCost: number; currency: string; offline: boolean;
}
interface ChatReply { reply: string | null; state: ChatState }

const SPLIT = "ab";

export function ChatTab({ journey }: { journey: string }) {
  const [versions, setVersions] = useState<number[]>([]);
  const [live, setLive] = useState<number | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [state, setState] = useState<ChatState | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const j = encodeURIComponent(journey);
      const [v, l] = await Promise.all([
        fetch(`/api/journeys/${j}/versions`), fetch(`/api/journeys/${j}/live`),
      ]);
      if (!v.ok) return;
      const list = (await v.json()).versions as number[];
      const liveVersion = l.ok ? ((await l.json()).version as number) : null;
      setVersions(list);
      setLive(liveVersion);
      // Default to what real leads meet, not to the newest thing published.
      setChoice(String(liveVersion ?? list[0] ?? ""));
    })();
  }, [journey]);

  // Follow the conversation as it grows, the way a chat window should.
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [state?.turns.length]);

  const call = async (url: string, body: unknown) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      setState(((await r.json()) as ChatReply).state);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const start = () => {
    setState(null);
    // An A/B split assigns deterministically per session, which is how a new
    // version takes real traffic without disturbing the one already running.
    void call("/api/chat/sessions", choice === SPLIT
      ? { journey, split: { [String(live)]: 50, [String(candidate)]: 50 } }
      : { journey, version: Number(choice) });
  };

  const send = () => {
    if (!state || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    void call(`/api/chat/sessions/${state.leadId}/messages`, { text });
  };

  // The newest published version that is not already live — the thing you would
  // be testing, and the other arm of a sensible A/B.
  const candidate = versions.find((v) => v !== live) ?? null;
  const done = state?.completed || state?.escalated;

  return (
    <>
      <p className="muted">
        A real conversation with a published agent. Pick the live version to see what leads
        see, or a newer one to try it before you promote it. Everything it writes lands in
        the same event log the other tabs read — which is why a chat you have here shows up
        in ROI.
      </p>

      <div className="ask">
        <select className="ask-input" value={choice} disabled={busy || !!state}
                onChange={(e) => setChoice(e.target.value)} aria-label="Version">
          {versions.map((v) => (
            <option key={v} value={String(v)}>
              v{v}{v === live ? " — live" : ""}
            </option>
          ))}
          {/* Live against the newest candidate: the split anyone actually wants,
              rather than whichever two versions happen to be newest. */}
          {candidate !== null && live !== null && (
            <option value={SPLIT}>A/B — v{live} (live) vs v{candidate}</option>
          )}
        </select>
        {/* The runtime never sees the channel — it returns intents and the
            caller delivers them — so these are a delivery gap, not a rebuild. */}
        <select className="ask-input" style={{ maxWidth: 190 }} value="web" disabled
                title={item("channels").will} aria-label="Channel">
          <option value="web">Web chat</option>
          <option>WhatsApp — soon</option>
          <option>Voice — soon</option>
        </select>
        <button className="btn" disabled={busy || !choice} onClick={start}>
          {state ? "Start another" : "Start chat"}
        </button>
      </div>

      {error && <p className="err">Chat failed: {error}</p>}

      {state?.offline && (
        <div className="alert warn">
          No model credential, so a deterministic keyword extractor is answering. It reads
          the declared options out of what you type — <em>"the Executive MBA, this
          intake"</em> works — but it cannot infer, so <em>"I decide myself"</em> will not
          give it <code>self</code>. The events and the contract on the right are real; the
          conversation quality is not representative.
        </div>
      )}

      {state && (
        <div className="chat">
          <div className="chat-main">
            <div className="chat-log" ref={log}>
              {state.turns.map((t, i) => (
                <div key={i} className={`bubble ${t.role}`}>{t.text}</div>
              ))}
              {busy && <div className="bubble agent muted">…</div>}
            </div>

            {done ? (
              <p className="muted">
                {state.escalated
                  ? `Escalated to a human — the rule "${state.escalationRule}" fired.`
                  : `Conversation complete. Routed ${state.decision}.`}
              </p>
            ) : (
              <div className="ask">
                <input className="ask-input" value={draft} disabled={busy}
                       placeholder="Reply as the lead…"
                       onChange={(e) => setDraft(e.target.value)}
                       onKeyDown={(e) => { if (e.key === "Enter") send(); }}
                       aria-label="Your reply" />
                <button className="btn" disabled={busy || !draft.trim()} onClick={send}>Send</button>
              </div>
            )}
          </div>

          {/* The evidence contract filling in as you talk is the argument for
              declaring a journey rather than prompting one. */}
          <aside className="chat-side">
            <h3 className="view-title">
              Evidence contract · v{state.version}
              {state.version === live ? " (live)" : " (testing)"}
            </h3>
            <table>
              <tbody>
                {state.evidence.map((e) => (
                  <tr key={e.field}>
                    <td>
                      <code>{e.field}</code>
                      {e.required && <span className="tag">required</span>}
                      {e.sensitive && <span className="tag">sensitive</span>}
                    </td>
                    <td className={e.value === null ? "muted" : "ok"}>
                      {e.value === null ? "—" : String(e.value)}
                      {e.confidence !== null && (
                        <span className="muted"> ({e.confidence.toFixed(2)})</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3 className="view-title">Outcome</h3>
            <table>
              <tbody>
                <tr><td>score</td><td>{state.score ?? <span className="muted">—</span>}</td></tr>
                <tr><td>route</td><td>{state.decision ?? <span className="muted">—</span>}</td></tr>
                <tr>
                  <td>model cost</td>
                  <td>{state.modelCost === 0
                    ? <span className="muted">no model call</span>
                    : money(state.modelCost, state.currency)}</td>
                </tr>
              </tbody>
            </table>

            <h3 className="view-title">Declared metrics</h3>
            <table>
              <tbody>
                {Object.entries(state.metrics).map(([name, value]) => (
                  <tr key={name}>
                    <td><code>{name}</code></td>
                    <td className={value === true ? "ok" : "muted"}>
                      {typeof value === "boolean" ? (value ? "true" : "false") : String(value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted provenance">
              These are this journey's own metrics, not a platform definition.
            </p>
          </aside>
        </div>
      )}
    </>
  );
}

