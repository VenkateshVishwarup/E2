const KEY = "e2.api_token";

export const storedToken = (): string | null => {
  try { return localStorage.getItem(KEY); } catch { return null; }
};

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(KEY, token); else localStorage.removeItem(KEY);
  } catch { /* private browsing: the token simply does not persist */ }
}

export const LOCKED = "e2:locked";

/**
 * Attaches the API token to every call, and raises an event when the server
 * says it is wrong.
 *
 * A wrapper rather than a prop threaded through nine screens: the token is a
 * transport concern, and every screen already calls `fetch` directly. Wrapping
 * once keeps them all unchanged and means a new screen cannot forget it.
 *
 * The token lives in localStorage, so it is only as private as the browser it
 * is typed into. That is the right trade for a deployment gate on a demo, and
 * the wrong one for real customer data — which is why the deployment notes
 * point at platform-level protection as the primary control.
 */
export function installAuth(): void {
  const original = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const token = storedToken();   // captured now, so the 401 check can compare
    const headers = new Headers(init?.headers ?? (input as Request)?.headers);
    if (token && url.startsWith("/api")) headers.set("authorization", `Bearer ${token}`);

    const res = await original(input, { ...init, headers });
    if (res.status === 401) {
      // Which 401 is this? Requests made before a token was entered resolve
      // *after* it is, and treating those as a rejection wiped the token the
      // moment it was set — the unlock screen came straight back with an empty
      // localStorage. Only a request that carried the token still in storage
      // says anything about whether that token is good.
      const current = storedToken();
      if (token !== null && token === current) {
        setToken(null);
        window.dispatchEvent(new CustomEvent(LOCKED));
      } else if (current === null) {
        window.dispatchEvent(new CustomEvent(LOCKED));
      }
    }
    return res;
  };
}
