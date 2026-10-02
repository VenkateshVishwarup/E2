import { useEffect, useRef, useState } from "react";
import { VersionPicker } from "./VersionPicker.js";
import { item } from "./roadmap-data.js";
import { readStrategy, switchStrategy, type StrategyKind } from "./strategy-yaml.js";
import { asNewJourney, journeyNameProblem } from "./journey-yaml.js";

interface SpecWarning { code: string; message: string }
interface LintResult {
  valid: boolean; journey?: string; version?: number;
  strategy?: StrategyKind;
  error?: string; warnings: SpecWarning[];
}

/**
 * The two kinds of agent, in the words a marketer would use.
 *
 * "Deterministic" and "non-deterministic" are the honest names and the ones the
 * spec uses, but they describe the mechanism rather than the consequence. The
 * consequence is what someone choosing between them needs.
 */
const STRATEGIES: Record<StrategyKind, { label: string; blurb: string }> = {
  scripted: {
    label: "Deterministic",
    blurb:
      "Works through the evidence contract in a fixed order. The same conversation " +
      "always goes the same way, and it costs one model call a turn. It cannot answer " +
      "a question, handle an objection, or notice that a lead has stopped cooperating.",
  },
  open: {
    label: "Non-deterministic",
    blurb:
      "The agent picks its own next move each turn — answer, acknowledge, use a tool, " +
      "ask, close, hand over — and says why. Two identical conversations may diverge. " +
      "Every choice is checked against policy before it happens and recorded either way, " +
      "so you can see what it decided and what it was not allowed to do.",
  },
};

export function JourneyEditor({ journey, journeys, flash, onPublished }: {
  journey: string;
  /** Every journey's name, so a new one cannot collide with an existing one. */
  journeys: string[];
  /** A message carried across the remount that follows creating a journey. */
  flash: string | null;
  /** Called with the journey actually published, which may be a new one. */
  onPublished: (journey: string, message: string) => void;
}) {
  const [versions, setVersions] = useState<number[]>([]);
  const [liveVersion, setLiveVersion] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [yaml, setYaml] = useState("");
  const [lint, setLint] = useState<LintResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(flash);
  const [error, setError] = useState<string | null>(null);
  /** The name being typed for a new journey, or null when not naming one. */
  const [newName, setNewName] = useState<string | null>(null);
  /** The YAML exactly as published, so an edit is distinguishable from a load. */
  const [pristine, setPristine] = useState("");
  /** Guards against a slow load landing after a newer selection. */
  const request = useRef(0);

  const load = async (version: number, keepNotice = false) => {
    const seq = ++request.current;
    setError(null);
    if (!keepNotice) setNotice(null);
    setLoaded(version);
    const r = await fetch(`/api/journeys/${encodeURIComponent(journey)}/source?version=${version}`);
    if (seq !== request.current) return;   // a newer selection won
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`); return; }
    const body = await r.json();
    if (seq !== request.current) return;
    setYaml(body.yaml);
    setPristine(body.yaml);
  };

  const refresh = async (): Promise<number[]> => {
    const j = encodeURIComponent(journey);
    const [v, l] = await Promise.all([
      fetch(`/api/journeys/${j}/versions`), fetch(`/api/journeys/${j}/live`),
    ]);
    const list = v.ok ? ((await v.json()).versions as number[]) : [];
    setVersions(list);
    setLiveVersion(l.ok ? ((await l.json()).version as number) : null);
    return list;
  };

  useEffect(() => {
    void (async () => {
      const list = await refresh();
      // The first load keeps a flash: it is the confirmation of whatever
      // brought the editor here, and clearing it would leave no trace of it.
      if (list[0] !== undefined) await load(list[0], true);
    })();
    // `load` is stable for a given journey; re-running on it would loop.
  }, [journey]);

  // Check as you type, so a problem shows up before publishing rather than after.
  useEffect(() => {
    if (!yaml) return;
    const timer = setTimeout(() => {
      void (async () => {
        const r = await fetch("/api/journeys/lint", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ yaml }),
        });
        if (r.ok) setLint(await r.json());
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [yaml]);

  // The server's own parse is the authority on what the YAML currently says; the
  // text is only read as a fallback while a lint request is in flight.
  const strategy: StrategyKind = lint?.strategy ?? (yaml ? readStrategy(yaml) : "scripted");

  const chooseStrategy = (kind: StrategyKind) => {
    if (kind === strategy) return;
    setYaml((y) => switchStrategy(y, kind));
    setNotice(
      `Switched to ${STRATEGIES[kind].label.toLowerCase()}. This is a change to a ` +
      `published version, so bump the version and publish it — then try it on the ` +
      `Chat tab before making it live.`,
    );
  };

  const nameProblem = newName === null ? null : journeyNameProblem(newName, journeys);

  /**
   * A journey exists once its first version is published, so starting one is a
   * copy of what is on screen under a new name at version 1 — the author then
   * changes what should differ, and publishing creates it.
   */
  const startNewJourney = () => {
    if (newName === null || nameProblem) return;
    setYaml((y) => asNewJourney(y, newName));
    setNotice(
      `A copy of v${loaded} as ${newName}, at version 1. Change what should differ, then ` +
      `publish — that creates the journey, and its first version goes live at once, ` +
      `because a journey with nothing live serves nobody.`);
    setNewName(null);
  };

  const bumpVersion = () => {
    setYaml((y) => y.replace(/^version:\s*(\d+)/m, (_, n: string) => `version: ${Number(n) + 1}`));
    setNotice(null);
  };

  const publish = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await fetch("/api/journeys/publish", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ yaml }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      if (body.journey !== journey) {
        // The console switches to the journey just published and this editor
        // remounts on it, so the confirmation travels with the switch.
        onPublished(body.journey, journeys.includes(body.journey)
          ? `Published v${body.version} of ${body.journey}. It is not live yet — promote it ` +
            `when you are happy.`
          : `Created ${body.journey}. Its first version, v${body.version}, is live — try it ` +
            `on the Chat tab.`);
        return;
      }
      const message =
        `Published v${body.version}. It is not live yet — try it on the Chat tab by ` +
        `selecting v${body.version}, then promote it when you are happy.`;
      setNotice(message);
      setPristine(yaml);
      await refresh();
      setLoaded(body.version);
      onPublished(body.journey, message);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  // The spec names its own journey, and that — not the picker — decides where a
  // publish lands. Say so when they differ, rather than letting a renamed spec
  // quietly become a different journey.
  const target = lint?.valid ? lint.journey : undefined;
  const elsewhere = target !== undefined && target !== journey;
  const createsJourney = elsewhere && !journeys.includes(target);
  const alreadyPublished =
    !elsewhere && lint?.version !== undefined && versions.includes(lint.version);
  const dirty = yaml !== "" && yaml !== pristine;
  const isLive = loaded !== null && loaded === liveVersion;
  const canPromote = alreadyPublished && !dirty && !isLive;

  const promote = async () => {
    if (loaded === null) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await fetch(`/api/journeys/${encodeURIComponent(journey)}/promote`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: loaded }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      const message =
        `v${loaded} is live. New conversations get it; ones already running keep the version they started on.`;
      setNotice(message);
      await refresh();
      onPublished(journey, message);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <p className="muted">
        The journey is a typed contract, not a prompt. <strong>Publishing is not
        shipping:</strong> a published version exists and can be talked to on the Chat tab,
        but real traffic keeps meeting the live one until you promote it. So the loop is
        edit → publish → try it → make it live, and rolling back is promoting the previous
        version.
      </p>

      {/* Editing YAML is the general answer, but "can this agent go off script?"
          is the one decision people actually want to make, and nobody should have
          to know the block name to make it. The buttons perform the edit; the
          YAML below remains the truth. */}
      <div className="strategy">
        <span className="picker-label">Agent behaviour</span>
        <div className="strategy-choice" role="radiogroup" aria-label="Agent behaviour">
          {(Object.keys(STRATEGIES) as StrategyKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={strategy === kind}
              className="section"
              disabled={busy || yaml === ""}
              onClick={() => chooseStrategy(kind)}
            >
              {STRATEGIES[kind].label}
            </button>
          ))}
        </div>
        <p className="muted provenance">{STRATEGIES[strategy].blurb}</p>
      </div>

      {/* A dropdown whose options read "Load v4" looks like a button you have
          yet to press. It is a state control: it says which version you are
          editing, and the line beneath says what has happened to it. */}
      <div className="pickers">
        {loaded !== null && (
          <VersionPicker label="editing" versions={versions} value={loaded}
                         onChange={(v) => void load(v)} disabled={busy} />
        )}
        <button className="btn" onClick={bumpVersion} disabled={busy}>Bump version</button>
        <button className="btn" onClick={() => void publish()}
                disabled={busy || !lint?.valid || alreadyPublished}>
          {busy ? "Working…" : `Publish${lint?.version ? ` v${lint.version}` : ""}`}
        </button>
        {/* Shipping is a second, deliberate act. Publishing only makes a
            version exist so you can try it. */}
        <button className="btn" onClick={() => void promote()} disabled={busy || !canPromote}>
          {isLive ? `v${loaded} is live` : `Make v${loaded ?? "?"} live`}
        </button>
        <button className="btn" onClick={() => setNewName("")}
                disabled={busy || yaml === "" || newName !== null}>
          New journey
        </button>
      </div>

      {newName !== null && (
        <form className="new-journey"
              onSubmit={(e) => { e.preventDefault(); startNewJourney(); }}>
          <label className="picker">
            <span className="picker-label">new journey name</span>
            <input className="name-input" value={newName} autoFocus spellCheck={false}
                   placeholder="pgdm-admissions" aria-label="New journey name"
                   onChange={(e) => setNewName(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={nameProblem !== null}>
            Start from v{loaded}
          </button>
          <button className="btn" type="button" onClick={() => setNewName(null)}>Cancel</button>
          {newName !== "" && nameProblem && <p className="muted name-problem">{nameProblem}</p>}
        </form>
      )}

      <p className="muted">
        {createsJourney
          ? <>Publishing will create a new journey, <strong>{target}</strong>, starting at
              v{lint!.version}. Its first version goes live on publish.</>
        : elsewhere
          ? <>This spec names <strong>{target}</strong>, so publishing adds v{lint!.version} to
              that journey, not to {journey}.</>
        : dirty
          ? <>Editing <strong>v{loaded}</strong> with unsaved changes
              {lint?.version !== loaded && lint?.version ? <> — will publish as v{lint.version}</> : null}.</>
          : isLive
            ? <>Showing <strong>v{loaded}</strong>, which is live.</>
            : <>Showing <strong>v{loaded}</strong> exactly as published — <strong>not live</strong>.</>}
        {liveVersion !== null && !isLive && !elsewhere && <> v{liveVersion} is serving new conversations.</>}
      </p>

      {/* Versions are immutable, so say why the button is disabled rather than
          letting someone press it and read a 409. */}
      {alreadyPublished && (
        <p className="muted">
          v{lint!.version} is already published and versions are immutable. Bump the version
          to publish a change.
        </p>
      )}
      {notice && <p className="ok">{notice}</p>}
      {error && <p className="err">{error}</p>}

      <div className="editor">
        <textarea className="yaml-input" spellCheck={false} value={yaml}
                  onChange={(e) => setYaml(e.target.value)} aria-label="Journey specification" />

        <aside className="chat-side">
          <h3 className="view-title">Checks</h3>
          {!lint && <p className="muted">…</p>}
          {lint && !lint.valid && (
            <div className="alert critical">{lint.error}</div>
          )}
          {lint?.valid && lint.warnings.length === 0 && (
            <p className="ok">Parses, and clears every static check.</p>
          )}
          {lint?.warnings.map((w) => (
            <div className="alert warn" key={w.code}>
              <strong>{w.code}</strong>
              <div>{w.message}</div>
            </div>
          ))}
          <p className="muted provenance">
            Warnings do not block publishing. A journey may legitimately rely on optional
            evidence a lead volunteers, and the platform should not be the judge of that.
          </p>

          {/* An open journey's behaviour hinges on this block, and the connection
              between "the agent went vague" and "nobody declared that fact" is not
              obvious from the warning alone. */}
          {strategy === "open" && (
            <p className="muted provenance">
              A non-deterministic agent may state <strong>only</strong> what
              <code> knowledge:</code> declares, word for word. Anything else it admits it
              does not know. That is the line between an agent that can hold a
              conversation and one that can make things up.
            </p>
          )}

          {/* The `tools:` block is enforced but not yet connected. Say so where
              someone is editing it, not only on the roadmap. */}
          {yaml.includes("tools:") && (
            <p className="muted provenance">
              <span className="soon-tag">soon</span> Privileges under <code>tools:</code> are
              enforced today — an unprivileged call is denied and logged — but the bindings
              behind them are mocks. {item("bindings").will}
            </p>
          )}
        </aside>
      </div>
    </>
  );
}
