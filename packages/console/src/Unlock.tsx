import { useState } from "react";
import { setToken } from "./auth.js";

/**
 * Checks the token before storing it.
 *
 * Storing first and letting the app discover the problem meant a wrong token
 * returned to this screen with no message — indistinguishable from a bug, and
 * it cost a long debugging session to tell the two apart. One request answers
 * the question, so ask it here and say what happened.
 */
export function Unlock() {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const token = value.trim();
    if (!token || busy) return;

    // A provider key is not this token, and the two are easy to confuse when a
    // page mentions both. Say so before sending it anywhere — a credential
    // typed into the wrong box should not leave the browser.
    if (/^sk-/.test(token)) {
      setError(
        "That looks like an OpenAI key. This field wants the deployment's access " +
        "token — the value of API_TOKEN on the server — not a model credential. " +
        "Nothing was sent.",
      );
      return;
    }

    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/limits", { headers: { authorization: `Bearer ${token}` } });
      if (r.status === 401) {
        setError("That token was rejected. Check it against API_TOKEN on the server.");
        return;
      }
      if (!r.ok) {
        setError(`The server answered ${r.status}. The token may be fine; something else is wrong.`);
        return;
      }
      setToken(token);
      // Every screen already fetched and failed; a reload re-runs them all with
      // nothing stale still in flight.
      window.location.reload();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="empty">
      <h2>Sign in</h2>
      <p className="muted">
        Enter the deployment's <strong>access token</strong> — the value of{" "}
        <code>API_TOKEN</code> on the server. Not an OpenAI key, and not a password.
      </p>
      <p className="muted">
        This deployment is gated because anyone with the URL could otherwise run work
        against it. The token is kept in this browser only.
      </p>
      <div className="ask" style={{ maxWidth: 460, margin: "0 auto" }}>
        {/* Not a password: a password manager offering to fill this silently
            replaces the token with a saved credential for the domain. */}
        <input className="ask-input" type="text" value={value} autoFocus
               name="e2-access-token" placeholder="Access token (API_TOKEN)"
               aria-label="Deployment access token"
               autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
               data-1p-ignore data-lpignore="true" data-form-type="other"
               disabled={busy}
               onChange={(e) => { setValue(e.target.value); setError(null); }}
               onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
        <button className="btn" onClick={() => void submit()} disabled={busy || !value.trim()}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </div>
      {error && <p className="err">{error}</p>}
    </div>
  );
}
