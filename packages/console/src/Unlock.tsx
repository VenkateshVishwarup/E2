import { useState } from "react";
import { setToken } from "./auth.js";

export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [value, setValue] = useState("");

  const submit = () => {
    if (!value.trim()) return;
    setToken(value.trim());
    onUnlocked();
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
        <input className="ask-input" type="password" value={value} autoFocus
               placeholder="API token" aria-label="API token"
               onChange={(e) => setValue(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
        <button className="btn" onClick={submit} disabled={!value.trim()}>Unlock</button>
      </div>
    </div>
  );
}
