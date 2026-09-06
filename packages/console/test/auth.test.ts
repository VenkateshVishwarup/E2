import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installAuth, setToken, storedToken, LOCKED } from "../src/auth.js";

/** A minimal localStorage and fetch, so the interceptor can be driven directly. */
function harness(responses: number[]) {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });

  const sent: Array<string | null> = [];
  let i = 0;
  vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    sent.push(auth ? auth.replace("Bearer ", "") : null);
    return { status: responses[i++] ?? 200 } as Response;
  });

  const locks: number[] = [];
  vi.stubGlobal("window", {
    fetch: globalThis.fetch,
    addEventListener: () => {},
    dispatchEvent: (e: Event) => { if (e.type === LOCKED) locks.push(1); return true; },
    CustomEvent,
  });
  return { sent, locks };
}

afterEach(() => vi.unstubAllGlobals());

describe("the API token interceptor", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("attaches the stored token to /api calls and nothing else", async () => {
    const h = harness([200, 200]);
    installAuth();
    setToken("tok_abc");
    await window.fetch("/api/journeys/x/roi");
    await window.fetch("/health");
    expect(h.sent).toEqual(["tok_abc", null]);
  });

  it("clears the token when the request that carried it is rejected", async () => {
    const h = harness([401]);
    installAuth();
    setToken("wrong");
    await window.fetch("/api/journeys/x/roi");
    expect(storedToken()).toBeNull();
    expect(h.locks).toHaveLength(1);
  });

  it("does NOT clear a token because of a 401 from a request that predates it", async () => {
    // The bug this exists for: every screen fetches on load and gets 401.
    // Those responses arrive AFTER the token is typed, and treating them as a
    // rejection wiped it — the unlock screen came straight back, with an empty
    // localStorage and no explanation.
    const h = harness([401]);
    installAuth();
    const inFlight = window.fetch("/api/journeys/x/roi");   // sent with no token
    setToken("tok_valid");                                   // typed meanwhile
    await inFlight;
    expect(storedToken()).toBe("tok_valid");
    expect(h.locks).toHaveLength(0);
  });

  it("locks when there is no token at all", async () => {
    const h = harness([401]);
    installAuth();
    await window.fetch("/api/journeys/x/roi");
    expect(h.locks).toHaveLength(1);
  });
});
