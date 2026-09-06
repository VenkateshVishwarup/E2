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
      <h2>This deployment needs a token</h2>
      <p className="muted">
        It holds a model credential, so it is not left open — anyone with the URL could
        otherwise spend against it. The token is whatever <code>API_TOKEN</code> is set to on
        the server. It is kept in this browser only.
      </p>
      <div className="ask" style={{ maxWidth: 460, margin: "0 auto" }}>
        {/* Not a password: a password manager offering to fill this silently
            replaces the token with a saved credential for the domain. */}
        <input className="ask-input" type="text" value={value} autoFocus
               name="e2-api-token" placeholder="API token" aria-label="API token"
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
