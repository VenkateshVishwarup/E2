import { useEffect, useRef, useState } from "react";
import { VersionPicker } from "./VersionPicker.js";

interface SpecWarning { code: string; message: string }
interface LintResult {
  valid: boolean; journey?: string; version?: number;
  error?: string; warnings: SpecWarning[];
}

export function JourneyEditor({ journey, onPublished }:
  { journey: string; onPublished: () => void }) {
  const [versions, setVersions] = useState<number[]>([]);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [yaml, setYaml] = useState("");
  const [lint, setLint] = useState<LintResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The YAML exactly as published, so an edit is distinguishable from a load. */
  const [pristine, setPristine] = useState("");
  /** Guards against a slow load landing after a newer selection. */
  const request = useRef(0);

  const load = async (version: number) => {
    const seq = ++request.current;
    setError(null); setNotice(null);
    setLoaded(version);
    const r = await fetch(`/api/journeys/${encodeURIComponent(journey)}/source?version=${version}`);
    if (seq !== request.current) return;   // a newer selection won
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`); return; }
    const body = await r.json();
    if (seq !== request.current) return;
    setYaml(body.yaml);
    setPristine(body.yaml);
  };

  useEffect(() => {
    void (async () => {
      const r = await fetch(`/api/journeys/${encodeURIComponent(journey)}/versions`);
      if (!r.ok) return;
      const list = (await r.json()).versions as number[];
      setVersions(list);
      if (list[0] !== undefined) await load(list[0]);
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
      setNotice(`Published v${body.version}. It is live — start a chat and you will talk to it.`);
      setPristine(yaml);
      const list = await fetch(`/api/journeys/${encodeURIComponent(journey)}/versions`);
      if (list.ok) setVersions((await list.json()).versions);
      setLoaded(body.version);
      onPublished();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const alreadyPublished = lint?.version !== undefined && versions.includes(lint.version);
  const dirty = yaml !== "" && yaml !== pristine;

  return (
    <>
      <p className="muted">
        The journey is a typed contract, not a prompt. Publishing is deployment — there is
        no separate deploy step, and the next chat session is served by what you publish.
      </p>

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
          {busy ? "Publishing…" : `Publish${lint?.version ? ` v${lint.version}` : ""}`}
        </button>
      </div>

      <p className="muted">
        {dirty
          ? <>Editing <strong>v{loaded}</strong> with unsaved changes
              {lint?.version !== loaded && lint?.version ? <> — will publish as v{lint.version}</> : null}.</>
          : <>Showing <strong>v{loaded}</strong> exactly as published.</>}
        {versions[0] !== undefined && <> v{versions[0]} is the version chat serves.</>}
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
        </aside>
      </div>
    </>
  );
}
