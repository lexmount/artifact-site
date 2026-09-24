import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSessionCookie, endSession, isSameOrigin, mintSession, resolveSession } from "@/lib/session";
import { SESSION_COOKIE_NAMES } from "@/lib/session-cookie";
import { closeDbForTests, getSession, revokeUserSessions, upsertUser } from "@/lib/db";

const dirs: string[] = [];

/** Requests are https so the hardened __Host- cookie path is what gets exercised. */
function req(cookie?: string, headers: Record<string, string> = {}): Request {
  return new Request("https://hub.example/api/x", { headers: { ...(cookie ? { cookie } : {}), ...headers } });
}

/** Extract the raw cookie value from a Set-Cookie string. */
function cookieValue(setCookie: string): string {
  return setCookie.split(";")[0];
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-sess-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
});

afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
  delete process.env.ARTIFACT_PUBLIC_URL;
});

async function user() {
  return upsertUser({ authProvider: "test", providerSubject: `s${Math.random()}` });
}

describe("session round-trip", () => {
  it("uses the shared cookie names for minting and clearing on both protocols", async () => {
    const u = await user();
    for (const [protocol, name] of [["https", SESSION_COOKIE_NAMES.secure], ["http", SESSION_COOKIE_NAMES.development]]) {
      const request = new Request(`${protocol}://hub.example/api/x`);
      const { cookie } = await mintSession(request, u.id);
      expect(cookie.startsWith(`${name}=`)).toBe(true);
      expect(clearSessionCookie(request).startsWith(`${name}=`)).toBe(true);
      expect((await resolveSession(new Request(request.url, { headers: { cookie: cookieValue(cookie) } })))?.userId).toBe(u.id);
    }
  });
  it("mints a cookie that resolves back to the same session", async () => {
    const u = await user();
    const { cookie, session } = await mintSession(req(), u.id);
    const resolved = await resolveSession(req(cookieValue(cookie)));
    expect(resolved?.id).toBe(session.id);
    expect(resolved?.userId).toBe(u.id);
  });

  it("uses the __Host- prefix and full hardening over https", async () => {
    const u = await user();
    const { cookie } = await mintSession(req(), u.id);
    expect(cookie).toContain("__Host-ah_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    // __Host- is only valid without Domain; setting one would silently void the protection.
    expect(cookie).not.toContain("Domain=");
  });

  it("stores only the hash — the DB never holds a usable credential", async () => {
    const u = await user();
    const { cookie, session } = await mintSession(req(), u.id);
    const secret = decodeURIComponent(cookieValue(cookie).split("=").slice(1).join("="));

    expect(session.id).not.toBe(secret);
    expect(session.id).toBe(createHash("sha256").update(secret).digest("hex"));
    // A dump of the row cannot be replayed: looking the secret up as an id finds nothing.
    expect(await getSession(secret)).toBeNull();
  });
});

describe("session invalidation", () => {
  it("stops resolving once revoked", async () => {
    const u = await user();
    const { cookie } = await mintSession(req(), u.id);
    expect(await resolveSession(req(cookieValue(cookie)))).not.toBeNull();

    await endSession(req(cookieValue(cookie)));
    expect(await resolveSession(req(cookieValue(cookie)))).toBeNull();
  });

  it("revokes every other session of a user, sparing the current one", async () => {
    const u = await user();
    const a = await mintSession(req(), u.id);
    const b = await mintSession(req(), u.id);

    const n = await revokeUserSessions(u.id, b.session.id);
    expect(n).toBe(1);
    expect(await resolveSession(req(cookieValue(a.cookie)))).toBeNull();
    expect(await resolveSession(req(cookieValue(b.cookie)))).not.toBeNull();
  });

  it("never slides past the absolute ceiling", async () => {
    const u = await user();
    const { session } = await mintSession(req(), u.id);
    // The ceiling is fixed at login; a sliding refresh may approach but not exceed it, which is
    // what stops a stolen cookie from renewing itself indefinitely.
    expect(session.expiresAt).toBeLessThanOrEqual(session.absoluteExpiresAt);
  });

  it("clears the cookie with Max-Age=0", () => {
    expect(clearSessionCookie(req())).toContain("Max-Age=0");
  });
});

describe("cookie ambiguity", () => {
  it("refuses to guess when two cookies share the name", async () => {
    const u = await user();
    const { cookie } = await mintSession(req(), u.id);
    const real = cookieValue(cookie);
    // A sibling subdomain can plant a duplicate; picking either one is a coin flip we decline.
    const tossed = `${real}; __Host-ah_session=forged`;
    expect(await resolveSession(req(tossed))).toBeNull();
  });
});

describe("isSameOrigin", () => {
  beforeEach(() => { process.env.ARTIFACT_PUBLIC_URL = "https://hub.example"; });

  it("accepts an exact match", () => {
    expect(isSameOrigin(req(undefined, { origin: "https://hub.example" }))).toBe(true);
  });

  it("rejects a missing Origin rather than assuming same-site", () => {
    expect(isSameOrigin(req())).toBe(false);
  });

  it("rejects Origin: null — that is exactly what a sandboxed preview iframe sends", () => {
    expect(isSameOrigin(req(undefined, { origin: "null" }))).toBe(false);
  });

  it("rejects a different origin and a suffix look-alike", () => {
    expect(isSameOrigin(req(undefined, { origin: "https://evil.example" }))).toBe(false);
    expect(isSameOrigin(req(undefined, { origin: "https://hub.example.evil.com" }))).toBe(false);
  });
});

// Regressions from the PR #8 review. Each of these shipped once.
describe("cookie prefix cannot be downgraded", () => {
  it("ignores the unprefixed cookie on https", async () => {
    const u = await user();
    const { cookie } = await mintSession(req(), u.id);
    const secret = cookieValue(cookie).split("=").slice(1).join("=");

    // A sibling subdomain cannot set __Host-ah_session, but it CAN set ah_session with a Domain
    // attribute. Accepting that on https would hand back everything the prefix buys.
    const downgraded = new Request("https://hub.example/api/x", { headers: { cookie: `ah_session=${secret}` } });
    expect(await resolveSession(downgraded)).toBeNull();

    // Same value under the right name still resolves, so this is a name check, not a value bug.
    expect(await resolveSession(req(cookieValue(cookie)))).not.toBeNull();
  });
});

describe("sliding window actually slides", () => {
  it("gives the idle timeout a shorter horizon than the absolute ceiling", async () => {
    const u = await user();
    const { session } = await mintSession(req(), u.id);
    // When these were equal, min(now + TTL, absolute) always returned the current expiry, the
    // delta was 0, and the refresh never fired once — sessions hard-expired regardless of use.
    expect(session.absoluteExpiresAt).toBeGreaterThan(session.expiresAt);
  });
});
